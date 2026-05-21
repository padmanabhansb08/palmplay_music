/**
 * Cloud sync — Supabase playlists & liked songs (streaming metadata only).
 */
(function () {
    const CLOUD_ID_KEY = 'cloudId';

    function enabled() {
        return window.PalmPlayAuth?.isConfigured?.() && !!window.PalmPlayAuth?.getClient?.();
    }

    function client() {
        return window.PalmPlayAuth.getClient();
    }

    async function migrateLegacyUserId(email, newId) {
        if (!email || !newId || email === newId) return;
        const db = window.PalmPlayDB;
        if (!db) return;

        const pls = await db.playlists.where('userId').equals(email).toArray();
        for (const pl of pls) await db.playlists.update(pl.id, { userId: newId });

        const tracks = await db.tracks.where('userId').equals(email).toArray();
        for (const t of tracks) await db.tracks.update(t.id, { userId: newId });

        const likes = await db.likedSongs.where('userId').equals(email).toArray();
        for (const l of likes) await db.likedSongs.update(l.id, { userId: newId });
    }

    function trackRow(userId, playlistCloudId, track, sortOrder) {
        return {
            user_id: userId,
            playlist_id: playlistCloudId,
            source: track.source || null,
            external_id: track.externalId || track.id ? String(track.externalId || track.id) : null,
            name: track.name,
            artist: track.artist,
            album: track.album || null,
            duration: track.duration || 0,
            stream_url: track.streamUrl || track.url || null,
            art_url: track.artUrl || track.art || null,
            date_added: track.dateAdded || new Date().toISOString(),
            sort_order: sortOrder
        };
    }

    function likeRow(userId, liked) {
        return {
            user_id: userId,
            track_name: liked.trackName,
            artist: liked.artist,
            album: liked.album || null,
            duration: liked.duration || 0,
            stream_url: liked.url || liked.streamUrl || null,
            art_url: liked.artUrl || liked.art || null,
            source: liked.source || null,
            external_id: liked.externalId ? String(liked.externalId) : null,
            is_audius: !!liked.isAudius,
            is_catalog: !!liked.isCatalog,
            date_added: liked.dateAdded || new Date().toISOString()
        };
    }

    /**
     * Pull cloud library into Dexie, then app reloads via loadFromDatabase.
     */
    async function pullAndMerge(userId, email) {
        if (!enabled() || !userId) return;
        const sb = client();
        const db = window.PalmPlayDB;
        if (!sb || !db) return;

        if (email && email !== userId) await migrateLegacyUserId(email, userId);

        const { data: cloudPls, error: plErr } = await sb
            .from('user_playlists')
            .select('id, name, updated_at')
            .eq('user_id', userId)
            .order('updated_at', { ascending: false });
        if (plErr) throw plErr;

        const { data: cloudTracks, error: trErr } = await sb
            .from('playlist_tracks')
            .select('*')
            .eq('user_id', userId)
            .order('sort_order', { ascending: true });
        if (trErr) throw trErr;

        const { data: cloudLikes, error: likeErr } = await sb
            .from('user_liked_songs')
            .select('*')
            .eq('user_id', userId);
        if (likeErr) throw likeErr;

        const localPls = await db.playlists.where('userId').equals(userId).toArray();
        const cloudPlIds = new Set((cloudPls || []).map((p) => p.id));

        for (const cpl of cloudPls || []) {
            let local = localPls.find((p) => p.cloudId === cpl.id);
            if (!local) {
                const dexieId = await db.playlists.add({
                    name: cpl.name,
                    userId,
                    cloudId: cpl.id,
                    updatedAt: cpl.updated_at
                });
                local = { id: dexieId, name: cpl.name, cloudId: cpl.id };
            } else if (local.name !== cpl.name) {
                await db.playlists.update(local.id, { name: cpl.name, updatedAt: cpl.updated_at });
            }

            const rows = (cloudTracks || []).filter((t) => t.playlist_id === cpl.id);
            const existing = await db.tracks.where('playlistId').equals(local.id).toArray();
            const streamExisting = existing.filter((t) => !t.audioBlob);

            for (const old of streamExisting) {
                await db.tracks.delete(old.id);
            }

            let order = 0;
            for (const row of rows) {
                if (!row.stream_url) continue;
                await db.tracks.add({
                    userId,
                    playlistId: local.id,
                    cloudId: row.id,
                    source: row.source,
                    externalId: row.external_id,
                    name: row.name,
                    artist: row.artist,
                    album: row.album,
                    duration: row.duration,
                    streamUrl: row.stream_url,
                    artUrl: row.art_url,
                    dateAdded: row.date_added
                });
                order++;
            }
        }

        for (const lp of localPls) {
            if (lp.cloudId && !cloudPlIds.has(lp.cloudId)) {
                const tracks = await db.tracks.where('playlistId').equals(lp.id).toArray();
                const hasBlob = tracks.some((t) => t.audioBlob);
                if (!hasBlob) {
                    for (const t of tracks) await db.tracks.delete(t.id);
                    await db.playlists.delete(lp.id);
                }
            }
        }

        const localLikes = await db.likedSongs.where('userId').equals(userId).toArray();
        const cloudLikeKeys = new Set(
            (cloudLikes || []).map((l) => `${l.track_name}\0${l.artist}`)
        );

        for (const cl of cloudLikes || []) {
            const exists = localLikes.some(
                (l) => l.trackName === cl.track_name && l.artist === cl.artist
            );
            if (exists) continue;
            await db.likedSongs.add({
                userId,
                cloudId: cl.id,
                trackName: cl.track_name,
                artist: cl.artist,
                album: cl.album,
                duration: cl.duration,
                url: cl.stream_url,
                artUrl: cl.art_url,
                source: cl.source,
                externalId: cl.external_id,
                isAudius: cl.is_audius,
                isCatalog: cl.is_catalog,
                dateAdded: cl.date_added
            });
        }

        for (const ll of localLikes) {
            const key = `${ll.trackName}\0${ll.artist}`;
            if (ll.cloudId && !cloudLikeKeys.has(key)) {
                await db.likedSongs.delete(ll.id);
            }
        }
    }

    async function pushPlaylist(pl) {
        if (!enabled() || !pl || pl.isTemporary) return;
        const user = window.PalmPlayAuth.getUser();
        const userId = user.id;
        if (!userId) return;

        const sb = client();
        const db = window.PalmPlayDB;
        const row = await db.playlists.get(pl.id);
        if (!row) return;

        if (row.cloudId) {
            await sb.from('user_playlists').update({
                name: row.name,
                updated_at: new Date().toISOString()
            }).eq('id', row.cloudId).eq('user_id', userId);
            return;
        }

        const { data, error } = await sb.from('user_playlists').insert({
            user_id: userId,
            name: row.name
        }).select('id').single();
        if (error) {
            console.warn('pushPlaylist', error);
            return;
        }
        await db.playlists.update(pl.id, { cloudId: data.id });
        pl.cloudId = data.id;
    }

    async function pushPlaylistTracks(pl) {
        if (!enabled() || !pl?.cloudId) return;
        const userId = window.PalmPlayAuth.getUser().id;
        if (!userId) return;

        const sb = client();
        const db = window.PalmPlayDB;
        const tracks = await db.tracks.where('playlistId').equals(pl.id).toArray();
        const streamTracks = tracks.filter((t) => t.streamUrl && !t.audioBlob);

        await sb.from('playlist_tracks').delete().eq('playlist_id', pl.cloudId).eq('user_id', userId);

        if (!streamTracks.length) return;

        const rows = streamTracks.map((t, i) => trackRow(userId, pl.cloudId, t, i));
        const { error } = await sb.from('playlist_tracks').insert(rows);
        if (error) console.warn('pushPlaylistTracks', error);
    }

    async function deleteCloudPlaylist(pl) {
        if (!enabled() || !pl?.cloudId) return;
        const userId = window.PalmPlayAuth.getUser().id;
        if (!userId) return;
        await client().from('user_playlists').delete().eq('id', pl.cloudId).eq('user_id', userId);
    }

    async function pushLike(liked) {
        if (!enabled() || !liked) return;
        const userId = window.PalmPlayAuth.getUser().id;
        if (!userId) return;
        const { error } = await client().from('user_liked_songs').upsert(
            likeRow(userId, liked),
            { onConflict: 'user_id,track_name,artist' }
        );
        if (error) console.warn('pushLike', error);
    }

    async function removeLike(trackName, artist) {
        if (!enabled()) return;
        const userId = window.PalmPlayAuth.getUser().id;
        if (!userId) return;
        await client()
            .from('user_liked_songs')
            .delete()
            .eq('user_id', userId)
            .eq('track_name', trackName)
            .eq('artist', artist);
    }

    window.PalmPlaySync = {
        enabled,
        pullAndMerge,
        pushPlaylist,
        pushPlaylistTracks,
        deleteCloudPlaylist,
        pushLike,
        removeLike,
        CLOUD_ID_KEY
    };
})();

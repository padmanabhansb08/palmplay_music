/**
 * PalmPlay auth — Supabase when configured, else legacy localStorage session.
 */
(function () {
    let client = null;
    let initPromise = null;

    function cfg() {
        return window.PALMPLAY_SUPABASE || {};
    }

    function isConfigured() {
        const c = cfg();
        return !!(c.url && c.anonKey);
    }

    function readStoredUser() {
        try {
            return JSON.parse(localStorage.getItem('palmplay_user') || '{}');
        } catch (e) {
            return {};
        }
    }

    function writeStoredUser(user) {
        localStorage.setItem('palmplay_user', JSON.stringify(user));
        window.dispatchEvent(new CustomEvent('palmplay:authchange', { detail: user }));
    }

    function profileFromSession(session) {
        const u = session.user;
        const meta = u.user_metadata || {};
        const name = meta.display_name || meta.full_name || meta.name || (u.email ? u.email.split('@')[0] : 'User');
        return {
            id: u.id,
            email: u.email,
            name,
            isLoggedIn: true,
            provider: 'supabase'
        };
    }

    function clearStoredUser() {
        localStorage.removeItem('palmplay_user');
        window.dispatchEvent(new CustomEvent('palmplay:authchange', { detail: null }));
    }

    async function init() {
        if (initPromise) return initPromise;
        initPromise = (async () => {
            if (!isConfigured() || typeof window.supabase === 'undefined') {
                return false;
            }
            const { url, anonKey } = cfg();
            client = window.supabase.createClient(url, anonKey, {
                auth: {
                    persistSession: true,
                    autoRefreshToken: true,
                    detectSessionInUrl: true
                }
            });

            const { data: { session } } = await client.auth.getSession();
            if (session?.user) writeStoredUser(profileFromSession(session));

            client.auth.onAuthStateChange((_event, session) => {
                if (session?.user) writeStoredUser(profileFromSession(session));
                else clearStoredUser();
            });

            return true;
        })();
        return initPromise;
    }

    function getClient() {
        return client;
    }

    function getUser() {
        const u = readStoredUser();
        if (u.isLoggedIn && (u.id || u.email)) return u;
        return {};
    }

    async function signIn(email, password, captchaToken) {
        if (!client) await init();
        if (!client) throw new Error('Supabase is not configured');
        const options = captchaToken ? { captchaToken } : undefined;
        const { data, error } = await client.auth.signInWithPassword({ email, password, options });
        if (error) throw error;
        if (data.session) writeStoredUser(profileFromSession(data.session));
        return getUser();
    }

    async function signUp(email, password, displayName, captchaToken) {
        if (!client) await init();
        if (!client) throw new Error('Supabase is not configured');
        const options = {
            data: { display_name: displayName || email.split('@')[0] }
        };
        if (captchaToken) options.captchaToken = captchaToken;
        const { data, error } = await client.auth.signUp({
            email,
            password,
            options
        });
        if (error) throw error;
        if (data.session) writeStoredUser(profileFromSession(data.session));
        return { user: getUser(), needsEmailConfirm: !data.session };
    }

    async function signOut() {
        if (client) {
            try {
                await client.auth.signOut();
            } catch (e) {
                console.warn('Supabase signOut', e);
            }
        }
        clearStoredUser();
    }

    /** Legacy local-only session (no Supabase). */
    function setLocalSession(name, email) {
        writeStoredUser({ name, email, isLoggedIn: true, provider: 'local' });
    }

    window.PalmPlayAuth = {
        init,
        isConfigured,
        getClient,
        getUser,
        signIn,
        signUp,
        signOut,
        setLocalSession,
        clearStoredUser
    };
})();

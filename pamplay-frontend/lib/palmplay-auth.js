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

    /**
     * Absolute URL for email links (confirm sign-up, password reset).
     * Supabase ignores relative paths like "/app" and falls back to the
     * dashboard Site URL — which is how confirm links ended up on localhost.
     */
    function absoluteUrl(pageKey) {
        const origin = window.location.origin;
        const path = window.PalmPlayRoutes?.page?.(pageKey);
        if (path) return new URL(path, origin).href;
        const p = window.location.pathname;
        if (p.includes('/pamplay-frontend')) {
            const base = p.substring(0, p.indexOf('/pamplay-frontend') + '/pamplay-frontend/'.length);
            return `${origin}${base}${pageKey}.html`;
        }
        return `${origin}/app${pageKey === 'home' ? '' : '/' + pageKey}`;
    }

    function getEmailRedirectUrl() {
        return absoluteUrl('home');
    }

    async function init() {
        if (initPromise) return initPromise;
        initPromise = (async () => {
            if (!isConfigured() || typeof window.supabase === 'undefined') {
                return false;
            }
            const { url, anonKey } = cfg();
            try {
                client = window.supabase.createClient(url, anonKey, {
                    auth: {
                        persistSession: true,
                        autoRefreshToken: true,
                        detectSessionInUrl: true
                    }
                });

                client.auth.onAuthStateChange((event, session) => {
                    if (event === 'PASSWORD_RECOVERY') {
                        // User arrived from a "reset password" email link.
                        window.dispatchEvent(new CustomEvent('palmplay:passwordrecovery'));
                    }
                    if (session?.user) writeStoredUser(profileFromSession(session));
                    else if (event === 'SIGNED_OUT') clearStoredUser();
                });

                // Network can hang/fail here (token refresh). Never let that block
                // the whole app from starting — fall back to the cached profile.
                const res = await Promise.race([
                    client.auth.getSession(),
                    new Promise((resolve) => setTimeout(() => resolve({ data: { session: undefined }, timedOut: true }), 6000))
                ]);
                const session = res?.data?.session;
                if (session?.user) writeStoredUser(profileFromSession(session));
                else if (session === null && readStoredUser().provider === 'supabase') {
                    // Supabase says there's no session (expired/revoked) but we still
                    // show the user as logged in → clear so the UI doesn't lie.
                    clearStoredUser();
                }
            } catch (e) {
                console.warn('Supabase init failed; continuing offline', e);
            }
            return !!client;
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
            data: { display_name: displayName || email.split('@')[0] },
            emailRedirectTo: getEmailRedirectUrl()
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

    /** Send a password-reset email. The link returns to the login page. */
    async function resetPassword(email) {
        if (!client) await init();
        if (!client) throw new Error('Supabase is not configured');
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: absoluteUrl('login') });
        if (error) throw error;
    }

    /** Set a new password (after arriving from a reset link). */
    async function updatePassword(password) {
        if (!client) await init();
        if (!client) throw new Error('Supabase is not configured');
        const { data, error } = await client.auth.updateUser({ password });
        if (error) throw error;
        const { data: s } = await client.auth.getSession();
        if (s?.session) writeStoredUser(profileFromSession(s.session));
        return data;
    }

    /** Re-send the sign-up confirmation email. */
    async function resendConfirmation(email) {
        if (!client) await init();
        if (!client) throw new Error('Supabase is not configured');
        const { error } = await client.auth.resend({ type: 'signup', email, options: { emailRedirectTo: getEmailRedirectUrl() } });
        if (error) throw error;
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
        resetPassword,
        updatePassword,
        resendConfirmation,
        setLocalSession,
        clearStoredUser
    };
})();

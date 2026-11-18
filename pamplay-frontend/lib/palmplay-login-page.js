/**
 * Shared login / signup form handlers (Supabase or local fallback).
 */
(function () {
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function showToast(message, ms = 3500) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        while (container.children.length >= 3) container.children[0].remove();
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.setAttribute('role', 'status');
        // message is plain text (may contain user input) — never inject as HTML
        toast.innerHTML = `<i class="fas fa-info-circle" style="color:var(--primary)"></i> ${escapeHtml(message)}`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 2000);
        }, ms);
    }

    function redirectHome() {
        const home = window.PalmPlayRoutes?.page('home') || 'home.html';
        window.location.href = home;
    }

    function setLocalSession(name, email) {
        window.PalmPlayAuth?.setLocalSession?.(name, email);
        const user = { name, email, isLoggedIn: true, provider: 'local' };
        const accounts = JSON.parse(localStorage.getItem('palmplay_accounts') || '[]');
        if (!accounts.find((a) => a.email === email)) {
            accounts.push(user);
            localStorage.setItem('palmplay_accounts', JSON.stringify(accounts));
        }
    }

    async function afterAuth(name, verb = 'Welcome back') {
        showToast(`${verb}, ${name}! Redirecting...`);
        setTimeout(redirectHome, 1200);
    }

    const looksLikeEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);

    function friendlyAuthError(err) {
        const raw = err?.message || '';
        const msg = raw.toLowerCase();
        if (msg.includes('sitekey-secret-mismatch')) {
            return 'Captcha keys are misconfigured. In Supabase use the Turnstile Secret Key (not the Site Key). See docs/SUPABASE_SETUP.md.';
        }
        if (msg.includes('captcha')) {
            return 'Security check failed. Complete the captcha below or disable captcha in Supabase Auth settings.';
        }
        if (msg.includes('invalid login credentials')) return 'Wrong email or password. Please try again.';
        if (msg.includes('email not confirmed')) return 'Please confirm your email first — check your inbox (and spam).';
        if (msg.includes('user already registered') || msg.includes('already been registered')) {
            return 'An account with this email already exists. Please log in.';
        }
        if (msg.includes('password should be') || msg.includes('weak password')) return 'Password is too weak — use at least 6 characters.';
        if (msg.includes('rate limit') || msg.includes('too many') || err?.status === 429) {
            return 'Too many attempts. Please wait a minute and try again.';
        }
        if (msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed')) {
            return "Can't reach the server. Check your internet connection.";
        }
        if (msg.includes('not configured')) return 'Sign-in is temporarily unavailable. Please try again later.';
        return raw || 'Something went wrong. Please try again.';
    }

    /** Disable a submit button and show progress text; returns a restore fn. */
    function busy(form, text) {
        const btn = form?.querySelector('button[type="submit"]');
        if (!btn) return () => {};
        const old = btn.innerHTML;
        btn.disabled = true;
        btn.setAttribute('aria-busy', 'true');
        btn.innerHTML = `<i class="fas fa-spinner fa-spin"></i> ${escapeHtml(text)}`;
        return () => {
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.innerHTML = old;
        };
    }

    const useCloud = () => !!window.PalmPlayAuth?.isConfigured?.();

    // ── Email not confirmed → offer to resend ──────────────────────────────
    function offerResend(email) {
        const form = document.getElementById('login-form');
        if (!form || !email || document.getElementById('resend-confirm')) return;
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.id = 'resend-confirm';
        btn.className = 'auth-link-btn';
        btn.textContent = 'Resend confirmation email';
        btn.onclick = async () => {
            btn.disabled = true;
            try {
                await window.PalmPlayAuth.resendConfirmation(email);
                showToast(`Confirmation email sent to ${email}.`);
                btn.remove();
            } catch (err) {
                showToast(friendlyAuthError(err));
                btn.disabled = false;
            }
        };
        form.after(btn);
    }

    // ── Forgot password ────────────────────────────────────────────────────
    async function handleForgot(e) {
        e.preventDefault();
        if (!useCloud()) {
            showToast('Password reset needs an online account. Local accounts are stored only on this device.');
            return;
        }
        const input = document.getElementById('login-email');
        const email = input?.value?.trim();
        if (!looksLikeEmail(email || '')) {
            showToast('Enter your email address above, then tap "Forgot your password?" again.');
            input?.focus();
            return;
        }
        const link = e.currentTarget;
        link.style.pointerEvents = 'none';
        try {
            await window.PalmPlayAuth.resetPassword(email);
            // Same message whether or not the account exists (don't leak accounts).
            showToast(`If an account exists for ${email}, a reset link is on its way. Check your inbox.`, 6000);
        } catch (err) {
            showToast(friendlyAuthError(err));
        } finally {
            link.style.pointerEvents = '';
        }
    }

    // ── Arrived from a reset-password email → let them set a new password ──
    function showSetNewPassword() {
        const form = document.getElementById('login-form');
        if (!form || document.getElementById('new-password-form')) return;
        document.querySelector('.login-title') && (document.querySelector('.login-title').textContent = 'Set a new password');
        document.querySelector('.login-subtitle') && (document.querySelector('.login-subtitle').textContent = 'Choose a new password for your PalmPlay account.');
        const np = document.createElement('form');
        np.id = 'new-password-form';
        np.innerHTML = `
            <div class="input-group">
                <label for="new-pass">New password</label>
                <input type="password" id="new-pass" placeholder="At least 6 characters" minlength="6" autocomplete="new-password" required>
            </div>
            <div class="input-group">
                <label for="new-pass2">Confirm new password</label>
                <input type="password" id="new-pass2" placeholder="Repeat password" minlength="6" autocomplete="new-password" required>
            </div>
            <button type="submit" class="login-btn">Save new password</button>`;
        form.replaceWith(np);
        document.getElementById('forgot-link')?.remove();
        np.addEventListener('submit', async (ev) => {
            ev.preventDefault();
            const p1 = document.getElementById('new-pass').value;
            const p2 = document.getElementById('new-pass2').value;
            if (p1 !== p2) { showToast("Passwords don't match."); return; }
            const restore = busy(np, 'Saving...');
            try {
                await window.PalmPlayAuth.updatePassword(p1);
                const u = window.PalmPlayAuth.getUser();
                await afterAuth(u.name || 'there', 'Password updated. Welcome back');
            } catch (err) {
                showToast(friendlyAuthError(err));
                restore();
            }
        });
        document.getElementById('new-pass')?.focus();
    }

    async function handleLoginSubmit(e) {
        e.preventDefault();
        const form = e.currentTarget;
        const email = document.getElementById('login-email')?.value?.trim();
        const password = document.getElementById('login-pass')?.value;
        if (!email || !password) return;

        if (useCloud()) {
            if (!looksLikeEmail(email)) {
                showToast('Please enter the email address you signed up with.');
                return;
            }
            if (!window.PalmPlayCaptcha?.requireTokenOrToast?.(showToast)) return;
            const captchaToken = window.PalmPlayCaptcha?.getToken?.();
            const restore = busy(form, 'Logging in...');
            try {
                const user = await window.PalmPlayAuth.signIn(email, password, captchaToken);
                await afterAuth(user.name || email);
            } catch (err) {
                showToast(friendlyAuthError(err));
                if ((err?.message || '').toLowerCase().includes('email not confirmed')) offerResend(email);
                window.PalmPlayCaptcha?.reset?.();
                restore();
            }
            return;
        }

        const users = JSON.parse(localStorage.getItem('palmplay_registered_users') || '[]');
        const user = users.find((u) => (u.email === email || u.name === email) && u.password === password);
        if (user) {
            setLocalSession(user.name, user.email);
            await afterAuth(user.name);
        } else {
            showToast('Wrong email or password. Please try again.');
        }
    }

    async function handleSignupSubmit(e) {
        e.preventDefault();
        const form = e.currentTarget;
        const profileName = document.getElementById('signup-name')?.value?.trim();
        const email = document.getElementById('signup-email')?.value?.trim();
        const password = document.getElementById('signup-pass')?.value;
        if (!email || !password || !profileName) return;
        if (!looksLikeEmail(email)) { showToast('Please enter a valid email address.'); return; }
        if (password.length < 6) { showToast('Password is too weak — use at least 6 characters.'); return; }

        // Read cloud mode at submit time (it used to be read from a variable that
        // wasn't initialised yet if you submitted quickly → silent ReferenceError).
        if (useCloud()) {
            if (!window.PalmPlayCaptcha?.requireTokenOrToast?.(showToast)) return;
            const captchaToken = window.PalmPlayCaptcha?.getToken?.();
            const restore = busy(form, 'Creating account...');
            try {
                const { user, needsEmailConfirm } = await window.PalmPlayAuth.signUp(
                    email, password, profileName, captchaToken
                );
                if (needsEmailConfirm) {
                    showToast(`Almost done! We sent a confirmation link to ${email}. Open it, then log in.`, 7000);
                    setTimeout(() => {
                        window.location.href = window.PalmPlayRoutes?.page('login') || 'login.html';
                    }, 4000);
                    return;
                }
                await afterAuth(user.name || profileName, 'Welcome to PalmPlay');
            } catch (err) {
                showToast(friendlyAuthError(err));
                window.PalmPlayCaptcha?.reset?.();
                restore();
            }
            return;
        }

        const users = JSON.parse(localStorage.getItem('palmplay_registered_users') || '[]');
        if (users.find((u) => u.email === email)) {
            showToast('An account with this email already exists. Please log in.');
            setTimeout(() => {
                window.location.href = window.PalmPlayRoutes?.page('login') || 'login.html';
            }, 2000);
            return;
        }
        users.push({ name: profileName, email, password });
        localStorage.setItem('palmplay_registered_users', JSON.stringify(users));
        setLocalSession(profileName, email);
        showToast(`Welcome to PalmPlay, ${profileName}! Redirecting...`);
        setTimeout(redirectHome, 1500);
    }

    async function initAuthForms(mode) {
        // Attach listeners immediately so a fast submit never falls back to a
        // full-page form submission (refresh) while auth is still initialising.
        if (mode === 'login') {
            document.getElementById('login-form')?.addEventListener('submit', handleLoginSubmit);
            document.getElementById('forgot-link')?.addEventListener('click', handleForgot);
            window.addEventListener('palmplay:passwordrecovery', showSetNewPassword);
        } else if (mode === 'signup') {
            document.getElementById('signup-form')?.addEventListener('submit', handleSignupSubmit);
        }

        try {
            await window.PalmPlayAuth?.init?.();
        } catch (e) {
            console.warn('Auth init failed:', e);
        }

        // Supabase may have processed a recovery link before our listener existed.
        if (mode === 'login' && /type=recovery/.test(window.location.hash + window.location.search)) {
            showSetNewPassword();
        }

        const subtitle = document.querySelector('.login-subtitle');
        if (subtitle && useCloud() && mode === 'login' && !document.getElementById('new-password-form')) {
            subtitle.textContent = 'Sign in — playlists and likes sync across your devices.';
        }

        if (useCloud() && window.PalmPlayCaptcha?.isRequired?.()) {
            try {
                await window.PalmPlayCaptcha.mount('turnstile-widget');
            } catch (e) {
                console.warn('Turnstile mount failed', e);
            }
        }
    }

    window.PalmPlayLoginPage = { initAuthForms, showToast };
})();

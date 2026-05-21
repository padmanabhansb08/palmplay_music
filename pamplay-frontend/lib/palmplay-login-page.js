/**
 * Shared login / signup form handlers (Supabase or local fallback).
 */
(function () {
    function showToast(message) {
        const container = document.getElementById('toast-container');
        if (!container) return;
        while (container.children.length >= 3) container.children[0].remove();
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerHTML = `<i class="fas fa-info-circle" style="color:var(--primary)"></i> ${message}`;
        container.appendChild(toast);
        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 2000);
        }, 2500);
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

    async function afterAuth(name) {
        showToast(`Welcome back, ${name}! Redirecting...`);
        setTimeout(redirectHome, 1200);
    }

    async function initAuthForms(mode) {
        await window.PalmPlayAuth?.init?.();
        const useCloud = window.PalmPlayAuth?.isConfigured?.();
        const subtitle = document.querySelector('.login-subtitle');
        if (subtitle && useCloud) {
            subtitle.textContent = 'Sign in — playlists and likes sync across your devices.';
        }

        if (mode === 'login') {
            document.getElementById('login-form')?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const email = document.getElementById('login-email')?.value?.trim();
                const password = document.getElementById('login-pass')?.value;
                if (!email || !password) return;

                if (useCloud) {
                    try {
                        const user = await window.PalmPlayAuth.signIn(email, password);
                        await afterAuth(user.name || email);
                    } catch (err) {
                        showToast(err.message || 'Login failed');
                    }
                    return;
                }

                const users = JSON.parse(localStorage.getItem('palmplay_registered_users') || '[]');
                const user = users.find((u) => u.email === email && u.password === password);
                if (user) {
                    setLocalSession(user.name, email);
                    await afterAuth(user.name);
                } else {
                    showToast('Invalid email or password. Please try again.');
                }
            });
        }

        if (mode === 'signup') {
            document.getElementById('signup-form')?.addEventListener('submit', async (e) => {
                e.preventDefault();
                const profileName = document.getElementById('signup-name')?.value?.trim();
                const email = document.getElementById('signup-email')?.value?.trim();
                const password = document.getElementById('signup-pass')?.value;
                if (!email || !password || !profileName) return;

                if (useCloud) {
                    try {
                        const { user, needsEmailConfirm } = await window.PalmPlayAuth.signUp(email, password, profileName);
                        if (needsEmailConfirm) {
                            showToast('Check your email to confirm your account, then log in.');
                            setTimeout(() => {
                                window.location.href = window.PalmPlayRoutes?.page('login') || 'login.html';
                            }, 2500);
                            return;
                        }
                        await afterAuth(user.name || profileName);
                    } catch (err) {
                        showToast(err.message || 'Sign up failed');
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
            });
        }
    }

    window.PalmPlayLoginPage = { initAuthForms, showToast };
})();

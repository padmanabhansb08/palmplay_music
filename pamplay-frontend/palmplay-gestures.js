class PalmPlayGestures {
    constructor() {
        this.video = null;
        this.canvas = null;
        this.ctx = null;
        this.ws = null;
        this.isStreaming = false;
        this.loopId = null;
        
        // Cooldowns to prevent rapid triggers
        this.lastActionTime = 0;
        this.cooldownMs = 1500; // 1.5s cooldown for play/next/prev
    }

    async initialize() {
        this.setupUI();
        await this.startCamera();
        this.connectWebSocket();
    }

    setupUI() {
        // Create PiP Video Element
        this.video = document.createElement('video');
        this.video.autoplay = true;
        this.video.playsInline = true;
        this.video.style.position = 'fixed';
        this.video.style.bottom = '20px';
        this.video.style.right = '20px';
        this.video.style.width = '160px';
        this.video.style.height = '120px';
        this.video.style.borderRadius = '12px';
        this.video.style.boxShadow = '0 8px 32px rgba(0,0,0,0.5)';
        this.video.style.border = '2px solid rgba(255,255,255,0.1)';
        this.video.style.objectFit = 'cover';
        this.video.style.transform = 'scaleX(-1)'; // Mirror for user
        this.video.style.zIndex = '9999';
        this.video.style.transition = 'opacity 0.3s';
        this.video.id = 'gesture-pip-video';
        
        document.body.appendChild(this.video);

        // Hidden canvas for extracting frames
        this.canvas = document.createElement('canvas');
        this.canvas.width = 320; // Lower resolution for faster transmission/inference
        this.canvas.height = 240;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    }

    async startCamera() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ 
                video: { width: 320, height: 240, facingMode: "user" },
                audio: false
            });
            this.video.srcObject = stream;
            
            // Wait for video to be ready
            return new Promise(resolve => {
                this.video.onloadedmetadata = () => {
                    this.video.play();
                    resolve();
                };
            });
        } catch (err) {
            console.error("Camera access denied or failed:", err);
            if (this.video) this.video.style.display = 'none';
        }
    }

    connectWebSocket() {
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // If running locally, connect to local backend. Otherwise, use production backend URL.
        const wsHost = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
            ? 'localhost:8000'
            : 'YOUR_BACKEND_URL.onrender.com'; // TODO: Replace this once you deploy your backend
            
        const wsUrl = `${wsProtocol}//${wsHost}/ws/gesture`;
        this.ws = new WebSocket(wsUrl);
        
        this.ws.onopen = () => {
            console.log('Gesture WebSocket connected!');
            this.isStreaming = true;
            this.streamLoop();
        };
        
        this.ws.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.gesture) {
                    this.handleGesture(data);
                }
            } catch(e) {
                console.error("Error parsing gesture message:", e);
            }
        };
        
        this.ws.onclose = () => {
            console.log('Gesture WebSocket disconnected.');
            this.isStreaming = false;
            if (this.loopId) clearTimeout(this.loopId);
            
            // Try reconnecting after 3 seconds
            setTimeout(() => this.connectWebSocket(), 3000);
        };
        
        this.ws.onerror = (err) => {
            console.error('WebSocket Error:', err);
        };
    }

    streamLoop() {
        if (!this.isStreaming || this.ws.readyState !== WebSocket.OPEN) return;
        
        // Draw video frame to canvas
        if (this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
            this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
            
            // Convert to JPEG (quality 0.6 is good enough for inference and small over network)
            const base64Data = this.canvas.toDataURL('image/jpeg', 0.6);
            
            // Send to backend
            this.ws.send(base64Data);
        }
        
        // Target ~5 frames per second to avoid flooding the websocket and CPU
        this.loopId = setTimeout(() => this.streamLoop(), 200);
    }

    handleGesture(data) {
        // volume can be rapid fire, others need cooldown
        const now = Date.now();
        
        if (data.gesture === 'volume') {
            const volValue = data.value; // 0 to 100
            // Map 0-100 to 0.0-1.0 for the audio element
            if (window.audio) {
                window.audio.volume = volValue / 100;
                
                // Update slider UI if exists
                const volSlider = document.getElementById('volume-slider');
                if (volSlider) {
                    volSlider.value = volValue;
                    volSlider.style.background = `linear-gradient(to right, var(--text-primary) ${volValue}%, rgba(255,255,255,0.2) ${volValue}%)`;
                }
            }
            return;
        }

        // Apply cooldown to discrete actions like next/prev/toggle
        if (now - this.lastActionTime < this.cooldownMs) {
            return; 
        }

        let handled = false;
        
        if (data.gesture === 'toggle') {
            if (typeof window.togglePlay === 'function') {
                window.togglePlay();
                this.showFeedbackIcon('✊');
                handled = true;
            }
        } 
        else if (data.gesture === 'next') {
            if (typeof window.playNextTrack === 'function') {
                window.playNextTrack();
                this.showFeedbackIcon('⏭️');
                handled = true;
            }
        } 
        else if (data.gesture === 'prev') {
            if (typeof window.playPrevTrack === 'function') {
                window.playPrevTrack();
                this.showFeedbackIcon('⏮️');
                handled = true;
            }
        }

        if (handled) {
            this.lastActionTime = now;
        }
    }
    
    showFeedbackIcon(iconStr) {
        // Show a brief pop-up icon over the video
        let icon = document.getElementById('gesture-feedback-icon');
        if (!icon) {
            icon = document.createElement('div');
            icon.id = 'gesture-feedback-icon';
            icon.style.position = 'fixed';
            icon.style.bottom = '60px';
            icon.style.right = '80px';
            icon.style.fontSize = '48px';
            icon.style.zIndex = '10000';
            icon.style.pointerEvents = 'none';
            icon.style.transition = 'opacity 0.3s, transform 0.3s';
            icon.style.textShadow = '0 2px 10px rgba(0,0,0,0.5)';
            document.body.appendChild(icon);
        }
        
        icon.innerText = iconStr;
        icon.style.opacity = '1';
        icon.style.transform = 'translateY(0) scale(1.2)';
        
        setTimeout(() => {
            icon.style.opacity = '0';
            icon.style.transform = 'translateY(-20px) scale(1)';
        }, 800);
    }

    pause() {
        this.isStreaming = false;
        if (this.loopId) clearTimeout(this.loopId);
        if (this.video && this.video.srcObject) {
            this.video.srcObject.getTracks().forEach(track => track.stop());
            this.video.style.opacity = '0';
            setTimeout(() => { this.video.style.display = 'none'; }, 300);
        }
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.close();
        }
    }

    async resume() {
        if (this.video) {
            this.video.style.display = 'block';
            setTimeout(() => { this.video.style.opacity = '1'; }, 10);
        }
        await this.startCamera();
        this.connectWebSocket();
    }
}

// Global initializer
window.initGestures = () => {
    window.palmGestures = new PalmPlayGestures();
    window.palmGestures.initialize();
};

/**
 * Collaboration Client Module for SyncForge
 * Handles WebSocket communication, user presence, remote cursors, 
 * simulated co-workers (bots), and the local undo/redo stack.
 */

export class CollaborationClient {
    constructor(app) {
        this.app = app;
        this.ws = null;
        this.connected = false;
        
        // Generate random local user identity
        this.userId = 'user_' + Math.random().toString(36).substr(2, 9);
        this.userName = this.getRandomDeveloperName();
        this.userColor = this.getRandomColor();
        
        // Collab state
        this.remoteCursors = new Map(); // userId -> { name, color, x, y, lastSeen }
        this.activeUsers = new Map(); // userId -> { name, color, lastSeen }
        
        // Undo / Redo history stacks
        this.undoStack = [];
        this.redoStack = [];
        this.maxStackSize = 50;
        
        // Simulated Co-workers (Bots)
        this.botsEnabled = false;
        this.bots = [];
        this.botIntervalId = null;
        
        // Add local user to presence
        this.activeUsers.set(this.userId, {
            name: this.userName + " (You)",
            color: this.userColor,
            lastSeen: Date.now()
        });

        // Initialize WebSocket connection
        this.connect();
        
        // Set up cleanup loop for idle presence
        setInterval(() => this.cleanupIdleUsers(), 2000);
    }

    connect() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        // WebSocket runs on port 8001
        const wsUrl = `${protocol}//${window.location.hostname}:8001`;
        
        console.log(`Connecting to WebSocket: ${wsUrl}`);
        this.updateStatus('connecting', 'Connecting...');
        
        try {
            this.ws = new WebSocket(wsUrl);
            
            this.ws.onopen = () => {
                this.connected = true;
                this.updateStatus('connected', 'Connected');
                this.app.showToast("Connected to sync server", "success");
            };
            
            this.ws.onclose = () => {
                this.connected = false;
                this.updateStatus('disconnected', 'Disconnected');
                this.app.showToast("Disconnected from server. Retrying...", "warning");
                // Reconnect attempt in 3s
                setTimeout(() => this.connect(), 3000);
            };
            
            this.ws.onerror = (err) => {
                console.error("WebSocket error:", err);
            };
            
            this.ws.onmessage = (event) => {
                try {
                    const message = jsonSafeParse(event.data);
                    if (!message) return;
                    this.handleMessage(message);
                } catch (e) {
                    console.error("Error processing websocket message:", e);
                }
            };
        } catch (e) {
            console.error("Failed to establish WebSocket:", e);
            setTimeout(() => this.connect(), 3000);
        }
    }

    updateStatus(status, text) {
        const badge = document.getElementById('connection-status');
        const textSpan = document.getElementById('connection-text');
        if (!badge || !textSpan) return;
        
        badge.className = 'connection-badge ' + status;
        textSpan.textContent = text;
    }

    handleMessage(message) {
        switch (message.type) {
            case 'init':
                console.log("Received initial canvas state:", message.state);
                this.app.loadState(message.state, false);
                break;
                
            case 'state_update':
                // Remote update received: load state without saving to undo stack
                this.app.loadState(message.state, false);
                break;
                
            case 'cursor_move':
                // Record remote cursor position
                this.remoteCursors.set(message.userId, {
                    name: message.userName,
                    color: message.color,
                    x: message.x,
                    y: message.y,
                    lastSeen: Date.now()
                });
                
                // Also update presence
                this.activeUsers.set(message.userId, {
                    name: message.userName,
                    color: message.color,
                    lastSeen: Date.now()
                });
                
                this.updatePresenceUI();
                this.app.requestRedraw();
                break;
                
            case 'ping':
                // Create a visual ping ripple
                if (this.app.canvasEngine) {
                    this.app.canvasEngine.createRipple(message.x, message.y, message.color);
                }
                break;
                
            case 'traffic_inject':
                // Remote traffic injection started
                if (this.app.simulationEngine) {
                    this.app.simulationEngine.startTraffic(message.nodeId, message.rps, message.payloadSize, false);
                }
                break;
                
            case 'chaos_event':
                // Display chaos toast and trigger outage
                this.app.showToast(`CHAOS: ${message.description}`, "danger");
                if (this.app.simulationEngine) {
                    this.app.simulationEngine.triggerLocalOutage(message.targetId, message.eventType);
                }
                break;
        }
    }

    sendStateUpdate(state) {
        if (!this.connected) return;
        this.ws.send(JSON.stringify({
            type: 'state_update',
            state: {
                nodes: state.nodes,
                connections: state.connections
            }
        }));
    }

    sendCursorMove(x, y) {
        if (!this.connected) return;
        this.ws.send(JSON.stringify({
            type: 'cursor_move',
            userId: this.userId,
            userName: this.userName,
            color: this.userColor,
            x: x,
            y: y
        }));
    }

    sendPing(x, y) {
        if (!this.connected) return;
        this.ws.send(JSON.stringify({
            type: 'ping',
            x: x,
            y: y,
            color: this.userColor
        }));
    }

    sendTrafficInject(nodeId, rps, payloadSize) {
        if (!this.connected) return;
        this.ws.send(JSON.stringify({
            type: 'traffic_inject',
            nodeId: nodeId,
            rps: rps,
            payloadSize: payloadSize
        }));
    }

    sendChaosEvent(eventType, targetId, description) {
        if (!this.connected) return;
        this.ws.send(JSON.stringify({
            type: 'chaos_event',
            eventType: eventType,
            targetId: targetId,
            description: description
        }));
    }

    // Undo / Redo Stack Management
    pushState(state) {
        // Deep clone state to prevent reference issues
        const stateClone = JSON.parse(JSON.stringify(state));
        
        // Limit stack size
        if (this.undoStack.length >= this.maxStackSize) {
            this.undoStack.shift();
        }
        
        this.undoStack.push(stateClone);
        this.redoStack = []; // Clear redo stack on new action
        
        // Propagate state through WebSocket to other clients
        this.sendStateUpdate(stateClone);
    }

    undo() {
        if (this.undoStack.length <= 1) {
            this.app.showToast("Nothing to undo", "info");
            return;
        }
        
        // Pop current state and move to redo stack
        const currentState = this.undoStack.pop();
        this.redoStack.push(currentState);
        
        // Peek previous state
        const prevState = this.undoStack[this.undoStack.length - 1];
        
        // Load state locally and broadcast to others
        this.app.loadState(prevState, false);
        this.sendStateUpdate(prevState);
        this.app.showToast("Action undone", "info");
    }

    redo() {
        if (this.redoStack.length === 0) {
            this.app.showToast("Nothing to redo", "info");
            return;
        }
        
        const nextState = this.redoStack.pop();
        this.undoStack.push(nextState);
        
        this.app.loadState(nextState, false);
        this.sendStateUpdate(nextState);
        this.app.showToast("Action redone", "info");
    }

    // Presence management
    cleanupIdleUsers() {
        const now = Date.now();
        let changed = false;
        
        for (const [userId, user] of this.activeUsers.entries()) {
            if (userId === this.userId) continue; // Skip local user
            
            // If inactive for more than 10 seconds, remove cursor and presence
            if (now - user.lastSeen > 10000) {
                this.activeUsers.delete(userId);
                this.remoteCursors.delete(userId);
                changed = true;
            }
        }
        
        if (changed) {
            this.updatePresenceUI();
            this.app.requestRedraw();
        }
    }

    updatePresenceUI() {
        const avatarsBox = document.getElementById('presence-avatars-box');
        const countLabel = document.getElementById('presence-label-text');
        if (!avatarsBox || !countLabel) return;
        
        avatarsBox.innerHTML = '';
        
        this.activeUsers.forEach((user, id) => {
            const avatar = document.createElement('div');
            avatar.className = 'presence-avatar';
            avatar.style.backgroundColor = user.color;
            avatar.title = user.name;
            
            // Get initials (first letter of name or first two letters)
            const initials = user.name.split(' ').map(n => n[0]).join('').substr(0, 2).toUpperCase();
            avatar.textContent = initials;
            
            avatarsBox.appendChild(avatar);
        });
        
        const count = this.activeUsers.size;
        countLabel.textContent = `${count} developer${count > 1 ? 's' : ''} active`;
    }

    // Toggle Simulated Co-workers (Bots)
    toggleBots() {
        this.botsEnabled = !this.botsEnabled;
        const btn = document.getElementById('btn-coworkers');
        
        if (this.botsEnabled) {
            btn.classList.add('btn-active-toggle');
            this.initializeBots();
            this.app.showToast("Simulated developers joined the session", "info");
        } else {
            btn.classList.remove('btn-active-toggle');
            this.terminateBots();
            this.app.showToast("Simulated developers left", "info");
        }
    }

    initializeBots() {
        // Create 2 mock bot players
        this.bots = [
            {
                id: 'bot_alice',
                name: 'Alice (Senior Architect)',
                color: '#ec4899',
                x: 200, y: 200,
                targetX: 200, targetY: 200,
                taskTimer: 0
            },
            {
                id: 'bot_bob',
                name: 'Bob (SRE Lead)',
                color: '#10b981',
                x: -300, y: 100,
                targetX: -300, targetY: 100,
                taskTimer: 0
            }
        ];
        
        // Register bots in presence
        this.bots.forEach(bot => {
            this.activeUsers.set(bot.id, {
                name: bot.name,
                color: bot.color,
                lastSeen: Date.now()
            });
        });
        this.updatePresenceUI();

        // Bot behavior loop (60fps animation tick)
        const tickBots = () => {
            if (!this.botsEnabled) return;
            
            const now = Date.now();
            this.bots.forEach(bot => {
                // Smooth interpolation towards target coordinates
                bot.x += (bot.targetX - bot.x) * 0.05;
                bot.y += (bot.targetY - bot.y) * 0.05;
                
                // Periodically broadcast cursor movements (simulate websocket traffic)
                if (Math.random() < 0.1 && this.connected) {
                    this.ws.send(JSON.stringify({
                        type: 'cursor_move',
                        userId: bot.id,
                        userName: bot.name,
                        color: bot.color,
                        x: bot.x,
                        y: bot.y
                    }));
                }
                
                // Manage bot decision-making intervals
                bot.taskTimer -= 16.7; // ~16.7ms per frame
                if (bot.taskTimer <= 0) {
                    // Plan next task
                    this.triggerBotBehavior(bot);
                    bot.taskTimer = 3000 + Math.random() * 5000; // Next decision in 3-8s
                }
                
                // Update presence timestamp
                const pUser = this.activeUsers.get(bot.id);
                if (pUser) pUser.lastSeen = now;
            });
            
            this.botIntervalId = requestAnimationFrame(tickBots);
        };
        
        this.botIntervalId = requestAnimationFrame(tickBots);
    }

    triggerBotBehavior(bot) {
        // Decide what to do
        const r = Math.random();
        
        if (r < 0.5) {
            // Move cursor to a random location in the workspace
            bot.targetX = (Math.random() - 0.5) * 800;
            bot.targetY = (Math.random() - 0.5) * 600;
        } 
        else if (r < 0.75) {
            // Move cursor towards an existing node to "inspect" it
            const nodeIds = Object.keys(this.app.nodes);
            if (nodeIds.length > 0) {
                const randomNode = this.app.nodes[nodeIds[Math.floor(Math.random() * nodeIds.length)]];
                bot.targetX = randomNode.x + (Math.random() - 0.5) * 100;
                bot.targetY = randomNode.y + (Math.random() - 0.5) * 100;
                
                // Occasionly trigger a visual "Ping" ripple to draw attention
                if (Math.random() < 0.4 && this.connected) {
                    setTimeout(() => {
                        this.ws.send(JSON.stringify({
                            type: 'ping',
                            x: randomNode.x,
                            y: randomNode.y,
                            color: bot.color
                        }));
                        // Triggers local visual for user too
                        this.app.canvasEngine.createRipple(randomNode.x, randomNode.y, bot.color);
                    }, 800);
                }
            }
        } 
        else {
            // Perform an edit! Drag an existing node or add a new one
            const nodeIds = Object.keys(this.app.nodes);
            if (nodeIds.length > 0 && Math.random() < 0.6) {
                // Drag a node
                const randId = nodeIds[Math.floor(Math.random() * nodeIds.length)];
                const node = this.app.nodes[randId];
                
                bot.targetX = node.x;
                bot.targetY = node.y;
                
                // Move it slightly
                setTimeout(() => {
                    const dx = (Math.random() - 0.5) * 150;
                    const dy = (Math.random() - 0.5) * 150;
                    
                    bot.targetX = node.x + dx;
                    bot.targetY = node.y + dy;
                    
                    this.app.updateNodePosition(randId, node.x + dx, node.y + dy);
                }, 1000);
            } else {
                // Place a new node
                const nodeTypes = ['ec2', 's3', 'rds', 'lambda'];
                const randType = nodeTypes[Math.floor(Math.random() * nodeTypes.length)];
                const x = (Math.random() - 0.5) * 600;
                const y = (Math.random() - 0.5) * 400;
                
                bot.targetX = x;
                bot.targetY = y;
                
                setTimeout(() => {
                    this.app.addNode(randType, x, y, `Bot-${bot.name.split(' ')[0]}-${randType.toUpperCase()}`);
                }, 1200);
            }
        }
    }

    terminateBots() {
        if (this.botIntervalId) {
            cancelAnimationFrame(this.botIntervalId);
            this.botIntervalId = null;
        }
        
        // Remove bots from presence
        this.bots.forEach(bot => {
            this.activeUsers.delete(bot.id);
            this.remoteCursors.delete(bot.id);
        });
        this.bots = [];
        this.updatePresenceUI();
        this.app.requestRedraw();
    }

    // Helpers
    getRandomDeveloperName() {
        const first = ['Dev', 'Code', 'Cloud', 'Byte', 'Stack', 'Git', 'Ops', 'Kernel', 'Net', 'SRE'];
        const last = ['Ninja', 'Architect', 'Wizard', 'Artisan', 'Commander', 'Slayer', 'Guru', 'Mechanic', 'Surgeon'];
        const num = Math.floor(Math.random() * 900) + 100;
        return `${first[Math.floor(Math.random() * first.length)]}${last[Math.floor(Math.random() * last.length)]}_${num}`;
    }

    getRandomColor() {
        const colors = [
            '#6366f1', // Indigo
            '#06b6d4', // Cyan
            '#ec4899', // Pink
            '#8b5cf6', // Purple
            '#14b8a6', // Teal
            '#f59e0b', // Amber
            '#10b981'  // Emerald
        ];
        return colors[Math.floor(Math.random() * colors.length)];
    }
}

function jsonSafeParse(str) {
    try {
        return JSON.parse(str);
    } catch (e) {
        return null;
    }
}

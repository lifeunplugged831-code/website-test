/**
 * High-Performance HTML5 Canvas Rendering Engine for SyncForge
 * Handles infinite pan, zoom, custom shape drawing, mouse event routing,
 * connection logic, and smooth 60 FPS animation.
 */

export class CanvasEngine {
    constructor(app, canvasElement) {
        this.app = app;
        this.canvas = canvasElement;
        this.ctx = this.canvas.getContext('2d');
        
        // Panning and Zooming State
        this.scale = 1.0;
        this.minScale = 0.2;
        this.maxScale = 3.0;
        this.offsetX = 0;
        this.offsetY = 0;
        
        // Mouse interaction state
        this.isPanning = false;
        this.panStart = { x: 0, y: 0 };
        this.dragStart = { x: 0, y: 0 };
        
        this.draggedNodeId = null;
        this.activeConnectionDrag = null; // { fromNodeId, fromPortType, fromPortX, fromPortY, currentX, currentY }
        
        this.hoveredPort = null; // { nodeId, portType }
        this.ripples = []; // Concentric ping visual triggers
        
        // Node dimensions
        this.nodeWidth = 140;
        this.nodeHeight = 80;
        this.portRadius = 6;
        
        // Spacebar dragging
        this.spacePressed = false;
        
        this.initEventListeners();
        this.resizeCanvas();
        this.centerCanvas();
        
        // Start animation loop
        this.animate();
    }

    centerCanvas() {
        this.offsetX = this.canvas.width / 2;
        this.offsetY = this.canvas.height / 2;
    }

    resizeCanvas() {
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.app.requestRedraw();
    }

    // Convert screen coordinates to world coordinates
    screenToWorld(screenX, screenY) {
        return {
            x: (screenX - this.offsetX) / this.scale,
            y: (screenY - this.offsetY) / this.scale
        };
    }

    // Convert world coordinates to screen coordinates
    worldToScreen(worldX, worldY) {
        return {
            x: worldX * this.scale + this.offsetX,
            y: worldY * this.scale + this.offsetY
        };
    }

    initEventListeners() {
        window.addEventListener('resize', () => this.resizeCanvas());
        
        // Spacebar detection for panning
        window.addEventListener('keydown', (e) => {
            if (e.code === 'Space') {
                this.spacePressed = true;
                if (!this.isPanning && document.activeElement.tagName !== 'INPUT') {
                    this.canvas.style.cursor = 'grab';
                }
            }
        });
        
        window.addEventListener('keyup', (e) => {
            if (e.code === 'Space') {
                this.spacePressed = false;
                this.canvas.style.cursor = 'default';
            }
        });

        // Mouse Down
        this.canvas.addEventListener('mousedown', (e) => {
            const worldCoords = this.screenToWorld(e.clientX, e.clientY);
            const clickedNode = this.getNodeAt(worldCoords.x, worldCoords.y);
            const clickedPort = this.getPortAt(e.clientX, e.clientY);
            
            // 1. Panning Trigger (Middle click, or Left click + Spacebar)
            if (e.button === 1 || (e.button === 0 && this.spacePressed)) {
                this.isPanning = true;
                this.panStart.x = e.clientX - this.offsetX;
                this.panStart.y = e.clientY - this.offsetY;
                this.canvas.style.cursor = 'grabbing';
                return;
            }
            
            if (e.button === 0) {
                // 2. Clicked a Port -> Start dragging connection line
                if (clickedPort) {
                    const portPos = this.getPortScreenPosition(clickedPort.nodeId, clickedPort.type);
                    const worldPortPos = this.screenToWorld(portPos.x, portPos.y);
                    this.activeConnectionDrag = {
                        fromNodeId: clickedPort.nodeId,
                        fromPortType: clickedPort.type,
                        startX: worldPortPos.x,
                        startY: worldPortPos.y,
                        currentX: worldCoords.x,
                        currentY: worldCoords.y
                    };
                    this.canvas.style.cursor = 'crosshair';
                    return;
                }
                
                // 3. Clicked a Node -> Select and start dragging node
                if (clickedNode) {
                    this.app.selectNode(clickedNode.id);
                    this.draggedNodeId = clickedNode.id;
                    this.dragStart.x = worldCoords.x - clickedNode.x;
                    this.dragStart.y = worldCoords.y - clickedNode.y;
                    this.canvas.style.cursor = 'grabbing';
                    return;
                }
                
                // 4. Clicked blank space -> Deselect node
                this.app.deselectNode();
            }
        });

        // Mouse Move
        this.canvas.addEventListener('mousemove', (e) => {
            const worldCoords = this.screenToWorld(e.clientX, e.clientY);
            
            // Broadcast local cursor position
            this.app.collabClient.sendCursorMove(worldCoords.x, worldCoords.y);
            
            // 1. Handle Canvas Panning
            if (this.isPanning) {
                this.offsetX = e.clientX - this.panStart.x;
                this.offsetY = e.clientY - this.panStart.y;
                this.app.requestRedraw();
                return;
            }
            
            // 2. Handle Connection Line Dragging
            if (this.activeConnectionDrag) {
                this.activeConnectionDrag.currentX = worldCoords.x;
                this.activeConnectionDrag.currentY = worldCoords.y;
                
                // Check if hovering an eligible target port
                const hoverPort = this.getPortAt(e.clientX, e.clientY);
                if (hoverPort && hoverPort.nodeId !== this.activeConnectionDrag.fromNodeId) {
                    // Only output to input connections allowed
                    const canConnect = (this.activeConnectionDrag.fromPortType === 'out' && hoverPort.type === 'in') ||
                                       (this.activeConnectionDrag.fromPortType === 'in' && hoverPort.type === 'out');
                    
                    if (canConnect) {
                        this.hoveredPort = hoverPort;
                    } else {
                        this.hoveredPort = null;
                    }
                } else {
                    this.hoveredPort = null;
                }
                
                this.app.requestRedraw();
                return;
            }
            
            // 3. Handle Node Dragging
            if (this.draggedNodeId) {
                const node = this.app.nodes[this.draggedNodeId];
                if (node) {
                    const nx = worldCoords.x - this.dragStart.x;
                    const ny = worldCoords.y - this.dragStart.y;
                    this.app.updateNodePosition(this.draggedNodeId, nx, ny);
                }
                return;
            }
            
            // 4. General Hover Checks
            const hoverPort = this.getPortAt(e.clientX, e.clientY);
            if (hoverPort) {
                this.hoveredPort = hoverPort;
                this.canvas.style.cursor = 'pointer';
            } else {
                this.hoveredPort = null;
                const hoverNode = this.getNodeAt(worldCoords.x, worldCoords.y);
                if (hoverNode) {
                    this.canvas.style.cursor = 'grab';
                } else {
                    this.canvas.style.cursor = this.spacePressed ? 'grab' : 'default';
                }
            }
            this.app.requestRedraw();
        });

        // Mouse Up
        window.addEventListener('mouseup', (e) => {
            // 1. Release Canvas Pan
            if (this.isPanning) {
                this.isPanning = false;
                this.canvas.style.cursor = this.spacePressed ? 'grab' : 'default';
                return;
            }
            
            // 2. Release Connection Drag -> Connect ports if valid
            if (this.activeConnectionDrag) {
                const dropPort = this.getPortAt(e.clientX, e.clientY);
                if (dropPort && dropPort.nodeId !== this.activeConnectionDrag.fromNodeId) {
                    const isFromOut = this.activeConnectionDrag.fromPortType === 'out';
                    const isToIn = dropPort.type === 'in';
                    const isFromIn = this.activeConnectionDrag.fromPortType === 'in';
                    const isToOut = dropPort.type === 'out';
                    
                    if ((isFromOut && isToIn) || (isFromIn && isToOut)) {
                        const fromNodeId = isFromOut ? this.activeConnectionDrag.fromNodeId : dropPort.nodeId;
                        const toNodeId = isFromOut ? dropPort.nodeId : this.activeConnectionDrag.fromNodeId;
                        
                        this.app.addConnection(fromNodeId, toNodeId);
                    }
                }
                this.activeConnectionDrag = null;
                this.hoveredPort = null;
                this.canvas.style.cursor = 'default';
                this.app.requestRedraw();
                return;
            }
            
            // 3. Release Node Drag -> Save state in collaboration
            if (this.draggedNodeId) {
                this.draggedNodeId = null;
                this.canvas.style.cursor = 'default';
                this.app.saveLocalState();
            }
        });

        // Mouse Zoom (Wheel)
        this.canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            
            // Find zoom anchor point in world space before zoom
            const worldAnchor = this.screenToWorld(e.clientX, e.clientY);
            
            // Calculate new scale factor
            const zoomIntensity = 0.1;
            let zoomFactor = e.deltaY < 0 ? (1 + zoomIntensity) : (1 - zoomIntensity);
            
            this.scale *= zoomFactor;
            this.scale = Math.max(this.minScale, Math.min(this.maxScale, this.scale));
            
            // Shift offsets to align the zoom anchor point
            this.offsetX = e.clientX - worldAnchor.x * this.scale;
            this.offsetY = e.clientY - worldAnchor.y * this.scale;
            
            this.app.requestRedraw();
        }, { passive: false });

        // Double click blank space to Ping
        this.canvas.addEventListener('dblclick', (e) => {
            const worldCoords = this.screenToWorld(e.clientX, e.clientY);
            const clickedNode = this.getNodeAt(worldCoords.x, worldCoords.y);
            
            if (!clickedNode) {
                // Trigger ping
                this.createRipple(worldCoords.x, worldCoords.y, this.app.collabClient.userColor);
                this.app.collabClient.sendPing(worldCoords.x, worldCoords.y);
            }
        });
    }

    createRipple(x, y, color) {
        this.ripples.push({
            x, y, color,
            radius: 5,
            maxRadius: 50,
            opacity: 1.0,
            speed: 1.5
        });
        this.app.requestRedraw();
    }

    getNodeAt(worldX, worldY) {
        const list = Object.values(this.app.nodes);
        // Search backwards to match z-index (top elements clicked first)
        for (let i = list.length - 1; i >= 0; i--) {
            const node = list[i];
            const halfW = this.nodeWidth / 2;
            const halfH = this.nodeHeight / 2;
            if (worldX >= node.x - halfW && worldX <= node.x + halfW &&
                worldY >= node.y - halfH && worldY <= node.y + halfH) {
                return node;
            }
        }
        return null;
    }

    getPortAt(screenX, screenY) {
        const worldCoords = this.screenToWorld(screenX, screenY);
        const node = this.getNodeAt(worldCoords.x, worldCoords.y);
        
        if (node) {
            // Check Input Port
            if (node.type !== 'traffic') { // Traffic source has no input
                const inPort = this.getPortScreenPosition(node.id, 'in');
                const dist = Math.hypot(screenX - inPort.x, screenY - inPort.y);
                if (dist <= this.portRadius + 6) {
                    return { nodeId: node.id, type: 'in' };
                }
            }
            // Check Output Port
            if (node.type !== 's3') { // S3 has no output
                const outPort = this.getPortScreenPosition(node.id, 'out');
                const dist = Math.hypot(screenX - outPort.x, screenY - outPort.y);
                if (dist <= this.portRadius + 6) {
                    return { nodeId: node.id, type: 'out' };
                }
            }
        }
        return null;
    }

    getPortScreenPosition(nodeId, portType) {
        const node = this.app.nodes[nodeId];
        if (!node) return { x: 0, y: 0 };
        
        let localX = 0;
        if (portType === 'in') {
            localX = -this.nodeWidth / 2;
        } else if (portType === 'out') {
            localX = this.nodeWidth / 2;
        }
        
        return this.worldToScreen(node.x + localX, node.y);
    }

    // Drag-Drop implementation for desktop sidebar
    handleNodeDrop(nodeType, clientX, clientY) {
        const worldCoords = this.screenToWorld(clientX, clientY);
        this.app.addNode(nodeType, worldCoords.x, worldCoords.y);
    }

    // Animation Tick
    animate() {
        requestAnimationFrame(() => this.animate());
        
        let needsRedraw = false;
        
        // 1. Update Ripple Physics
        if (this.ripples.length > 0) {
            this.ripples.forEach(r => {
                r.radius += r.speed;
                r.opacity = 1 - (r.radius / r.maxRadius);
            });
            this.ripples = this.ripples.filter(r => r.radius < r.maxRadius);
            needsRedraw = true;
        }
        
        // 2. If simulation is running traffic, we need constant updates at 60 FPS
        if (this.app.simulationEngine && this.app.simulationEngine.activePackets.length > 0) {
            this.app.simulationEngine.updatePackets();
            needsRedraw = true;
        }
        
        if (this.app.redrawRequested || needsRedraw) {
            this.draw();
            this.app.redrawRequested = false;
        }
    }

    draw() {
        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        ctx.save();
        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.scale, this.scale);
        
        // 1. Draw Grid Background
        this.drawGrid();
        
        // 2. Draw Connection Lines
        this.drawConnections();
        
        // 3. Draw Nodes
        this.drawNodes();
        
        // 4. Draw Ripples
        this.drawRipples();
        
        // 5. Draw Active Packet Particles
        if (this.app.simulationEngine) {
            this.app.simulationEngine.drawPackets(ctx);
        }
        
        // 6. Draw Connection Line Dragging Overlay
        this.drawConnectionDrag();
        
        // 7. Draw Remote Users Cursors
        this.drawRemoteCursors();
        
        ctx.restore();
    }

    drawGrid() {
        const ctx = this.ctx;
        const gridSize = 40;
        
        // Bounds of the screen in world coordinates
        const tl = this.screenToWorld(0, 0);
        const br = this.screenToWorld(this.canvas.width, this.canvas.height);
        
        const startX = Math.floor(tl.x / gridSize) * gridSize;
        const endX = Math.ceil(br.x / gridSize) * gridSize;
        const startY = Math.floor(tl.y / gridSize) * gridSize;
        const endY = Math.ceil(br.y / gridSize) * gridSize;
        
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
        ctx.lineWidth = 1 / this.scale;
        
        ctx.beginPath();
        for (let x = startX; x <= endX; x += gridSize) {
            ctx.moveTo(x, tl.y);
            ctx.lineTo(x, br.y);
        }
        for (let y = startY; y <= endY; y += gridSize) {
            ctx.moveTo(tl.x, y);
            ctx.lineTo(br.x, y);
        }
        ctx.stroke();
    }

    drawConnections() {
        const ctx = this.ctx;
        const connections = this.app.connections;
        
        ctx.lineWidth = 3;
        
        connections.forEach(conn => {
            const fromNode = this.app.nodes[conn.fromNode];
            const toNode = this.app.nodes[conn.toNode];
            
            if (fromNode && toNode) {
                const p1 = { x: fromNode.x + this.nodeWidth / 2, y: fromNode.y };
                const p2 = { x: toNode.x - this.nodeWidth / 2, y: toNode.y };
                
                // Draw dynamic neon path. Red if congested downstream.
                const isFailed = fromNode.status === 'outage' || toNode.status === 'outage';
                const isOverloaded = fromNode.status === 'bottleneck' || toNode.status === 'bottleneck';
                
                if (isFailed) {
                    ctx.strokeStyle = 'rgba(239, 68, 68, 0.2)';
                } else if (isOverloaded) {
                    ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)';
                } else {
                    ctx.strokeStyle = 'rgba(99, 102, 241, 0.5)';
                }
                
                // Draw bezier line
                ctx.beginPath();
                ctx.moveTo(p1.x, p1.y);
                const cp1x = p1.x + Math.abs(p2.x - p1.x) * 0.5;
                const cp2x = p2.x - Math.abs(p2.x - p1.x) * 0.5;
                ctx.bezierCurveTo(cp1x, p1.y, cp2x, p2.y, p2.x, p2.y);
                ctx.stroke();
            }
        });
    }

    drawNodes() {
        const ctx = this.ctx;
        const nodes = Object.values(this.app.nodes);
        const w = this.nodeWidth;
        const h = this.nodeHeight;
        
        nodes.forEach(node => {
            const isSelected = node.id === this.app.selectedNodeId;
            const status = node.status || 'healthy';
            
            ctx.save();
            ctx.translate(node.x, node.y);
            
            // Glow effect if selected or overloaded
            if (isSelected) {
                ctx.shadowColor = 'rgba(99, 102, 241, 0.4)';
                ctx.shadowBlur = 15;
            } else if (status === 'bottleneck') {
                ctx.shadowColor = 'rgba(245, 158, 11, 0.4)';
                ctx.shadowBlur = 15;
            } else if (status === 'outage') {
                ctx.shadowColor = 'rgba(239, 68, 68, 0.4)';
                ctx.shadowBlur = 15;
            }
            
            // 1. Draw Card Background
            ctx.fillStyle = 'rgba(15, 23, 42, 0.95)';
            ctx.strokeStyle = isSelected ? '#6366f1' : 'rgba(255, 255, 255, 0.08)';
            if (status === 'outage') ctx.strokeStyle = '#ef4444';
            else if (status === 'bottleneck') ctx.strokeStyle = '#f59e0b';
            
            ctx.lineWidth = 1.5;
            
            ctx.beginPath();
            ctx.roundRect(-w/2, -h/2, w, h, 12);
            ctx.fill();
            ctx.stroke();
            ctx.shadowBlur = 0; // Reset shadow for internal drawings
            
            // 2. Draw Type Tag/Icon Strip
            const accentColor = this.getNodeAccentColor(node.type);
            ctx.fillStyle = accentColor;
            ctx.fillRect(-w/2 + 2, -h/2 + 2, 4, h - 4); // Small left vertical indicator strip
            
            // 3. Draw Icon Text
            ctx.fillStyle = accentColor;
            ctx.font = 'bold 0.65rem "JetBrains Mono"';
            ctx.fillText(node.type.toUpperCase(), -w/2 + 12, -h/2 + 18);
            
            // 4. Draw Status Indicator Dot
            let statusColor = '#10b981'; // Green
            if (status === 'bottleneck') statusColor = '#f59e0b'; // Yellow
            else if (status === 'outage') statusColor = '#ef4444'; // Red
            
            ctx.beginPath();
            ctx.arc(w/2 - 14, -h/2 + 14, 4, 0, Math.PI * 2);
            ctx.fillStyle = statusColor;
            ctx.fill();
            
            // 5. Draw Node Label Name
            ctx.fillStyle = '#f8fafc';
            ctx.font = 'bold 0.8rem "Plus Jakarta Sans"';
            
            const labelText = node.name || 'node';
            // Truncate name if too long
            const maxLabelWidth = w - 24;
            let displayLabel = labelText;
            if (ctx.measureText(labelText).width > maxLabelWidth) {
                displayLabel = labelText.substring(0, 10) + '...';
            }
            ctx.fillText(displayLabel, -w/2 + 12, -h/2 + 36);
            
            // 6. Draw Sizing/Specs Text
            ctx.fillStyle = '#94a3b8';
            ctx.font = '500 0.65rem "Plus Jakarta Sans"';
            let specText = '';
            if (node.type === 'ec2' || node.type === 'rds') {
                specText = `${node.replicas || 1}x ${node.size || 't3.micro'}`;
            } else if (node.type === 'traffic') {
                specText = `${node.rps || 1000} RPS`;
            } else {
                specText = 'Standard Capacity';
            }
            ctx.fillText(specText, -w/2 + 12, -h/2 + 48);
            
            // 7. Draw Utilization bar if stress simulation is active
            if (node.type !== 'traffic' && node.type !== 's3') {
                const util = node.utilization || 0;
                const barW = w - 24;
                const barH = 4;
                const barX = -w/2 + 12;
                const barY = h/2 - 14;
                
                // Draw background
                ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
                ctx.roundRect(barX, barY, barW, barH, 2);
                ctx.fill();
                
                // Draw fill
                ctx.fillStyle = util > 85 ? '#ef4444' : (util > 50 ? '#f59e0b' : '#10b981');
                ctx.beginPath();
                ctx.roundRect(barX, barY, barW * (util / 100), barH, 2);
                ctx.fill();
                
                ctx.fillStyle = '#64748b';
                ctx.font = '600 0.55rem "Plus Jakarta Sans"';
                ctx.fillText(`Load: ${Math.round(util)}%`, -w/2 + 12, h/2 - 4);
            } else if (node.type === 'traffic') {
                // Just display active status
                ctx.fillStyle = '#06b6d4';
                ctx.font = '600 0.55rem "Plus Jakarta Sans"';
                ctx.fillText(`TRANSFERS ACTIVE`, -w/2 + 12, h/2 - 4);
            } else {
                ctx.fillStyle = '#94a3b8';
                ctx.font = '600 0.55rem "Plus Jakarta Sans"';
                ctx.fillText(`STORED DATA OBJECTS`, -w/2 + 12, h/2 - 4);
            }
            
            // 8. Draw Connection Ports (circles on the edge)
            ctx.lineWidth = 2;
            
            // Input Port (left side)
            if (node.type !== 'traffic') {
                const portHovered = this.hoveredPort && this.hoveredPort.nodeId === node.id && this.hoveredPort.type === 'in';
                ctx.beginPath();
                ctx.arc(-w/2, 0, this.portRadius, 0, Math.PI * 2);
                ctx.fillStyle = portHovered ? '#6366f1' : '#0f172a';
                ctx.strokeStyle = portHovered ? '#ffffff' : '#6366f1';
                ctx.fill();
                ctx.stroke();
            }
            
            // Output Port (right side)
            if (node.type !== 's3') {
                const portHovered = this.hoveredPort && this.hoveredPort.nodeId === node.id && this.hoveredPort.type === 'out';
                ctx.beginPath();
                ctx.arc(w/2, 0, this.portRadius, 0, Math.PI * 2);
                ctx.fillStyle = portHovered ? '#6366f1' : '#0f172a';
                ctx.strokeStyle = portHovered ? '#ffffff' : '#6366f1';
                ctx.fill();
                ctx.stroke();
            }
            
            ctx.restore();
        });
    }

    drawConnectionDrag() {
        if (!this.activeConnectionDrag) return;
        
        const ctx = this.ctx;
        const drag = this.activeConnectionDrag;
        
        ctx.save();
        ctx.strokeStyle = 'rgba(99, 102, 241, 0.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]); // Dashed line during drag
        
        ctx.beginPath();
        ctx.moveTo(drag.startX, drag.startY);
        
        // Draw a bezier curve towards mouse cursor
        const cp1x = drag.startX + (drag.currentX - drag.startX) * 0.5;
        const cp2x = drag.currentX - (drag.currentX - drag.startX) * 0.5;
        ctx.bezierCurveTo(cp1x, drag.startY, cp2x, drag.currentY, drag.currentX, drag.currentY);
        ctx.stroke();
        
        ctx.restore();
    }

    drawRipples() {
        const ctx = this.ctx;
        this.ripples.forEach(r => {
            ctx.save();
            ctx.strokeStyle = r.color;
            ctx.globalAlpha = r.opacity;
            ctx.lineWidth = 2;
            
            ctx.beginPath();
            ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
            ctx.stroke();
            
            ctx.beginPath();
            ctx.arc(r.x, r.y, r.radius * 0.6, 0, Math.PI * 2);
            ctx.stroke();
            
            ctx.restore();
        });
    }

    drawRemoteCursors() {
        const ctx = this.ctx;
        
        this.app.collabClient.remoteCursors.forEach((cursor, id) => {
            ctx.save();
            
            // Draw small cursor arrow
            ctx.fillStyle = cursor.color;
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 1;
            
            ctx.beginPath();
            ctx.moveTo(cursor.x, cursor.y);
            ctx.lineTo(cursor.x + 10, cursor.y + 15);
            ctx.lineTo(cursor.x + 3, cursor.y + 12);
            ctx.closePath();
            ctx.fill();
            ctx.stroke();
            
            // Draw name tag
            ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
            ctx.strokeStyle = cursor.color;
            ctx.lineWidth = 1;
            
            const tagHeight = 16;
            ctx.font = '500 0.6rem "Plus Jakarta Sans"';
            const nameWidth = ctx.measureText(cursor.name).width;
            const tagWidth = nameWidth + 8;
            
            ctx.beginPath();
            ctx.roundRect(cursor.x + 10, cursor.y + 12, tagWidth, tagHeight, 4);
            ctx.fill();
            ctx.stroke();
            
            ctx.fillStyle = '#ffffff';
            ctx.fillText(cursor.name, cursor.x + 14, cursor.y + 23);
            
            ctx.restore();
        });
    }

    getNodeAccentColor(type) {
        switch (type) {
            case 'traffic': return '#06b6d4'; // Cyan
            case 'alb': return '#6366f1';     // Indigo
            case 'ec2': return '#f59e0b';     // Amber
            case 'rds': return '#10b981';     // Emerald
            case 'lambda': return '#ec4899';  // Pink
            case 's3': return '#0ea5e9';      // Sky
            case 'redis': return '#ef4444';   // Rose
            default: return '#64748b';
        }
    }
}

/**
 * Simulation and Physics Engine for SyncForge
 * Handles load propagation algorithms, dynamic bottleneck calculations,
 * animated packet flow along bezier paths, gravity physics for dropped packets,
 * and the Chaos Engineering Mode.
 */

export class SimulationEngine {
    constructor(app) {
        this.app = app;
        
        this.activePackets = [];   // List of active packet particles: { id, connIndex, t, speed, color, state: 'flowing'|'dropping', dropX, dropY, vx, vy, alpha }
        this.lastSpawnTimes = new Map(); // connectionIndex -> timestamp
        
        // Chaos Mode State
        this.chaosActive = false;
        this.chaosIntervalId = null;
        
        // Cost and metric tracking
        this.totalSentPackets = 0;
        this.totalSuccessfulPackets = 0;
        this.availability = 100;
        this.peakRPS = 0;
        
        // Run network load propagation loop every 200ms
        this.propagateIntervalId = setInterval(() => this.propagateLoad(), 200);
    }

    destroy() {
        clearInterval(this.propagateIntervalId);
        if (this.chaosIntervalId) {
            clearInterval(this.chaosIntervalId);
        }
    }

    // Dynamic Infrastructure Load Propagation Algorithm
    propagateLoad() {
        const nodes = this.app.nodes;
        const connections = this.app.connections;
        
        // 1. Initialize loads
        for (const id in nodes) {
            const node = nodes[id];
            node.incomingRPS = 0;
            node.outgoingRPS = 0;
            node.droppedRPS = 0;
            
            // Set capacity based on node types and size configurations
            node.capacity = this.calculateNodeCapacity(node);
        }
        
        // 2. Set root traffic loads
        for (const id in nodes) {
            const node = nodes[id];
            if (node.type === 'traffic') {
                node.incomingRPS = node.status === 'outage' ? 0 : (node.rps || 1000);
                node.outgoingRPS = node.incomingRPS;
            }
        }
        
        // 3. Propagate load iteratively (up to 4 passes to handle typical DAG depths)
        const passes = 4;
        for (let pass = 0; pass < passes; pass++) {
            // Temporarily store accumulated incoming loads for this pass
            const passIncoming = {};
            for (const id in nodes) {
                passIncoming[id] = 0;
            }
            
            // Process each connection
            connections.forEach(conn => {
                const source = nodes[conn.fromNode];
                if (!source) return;
                
                // Distribute source outgoing load equally among its active outgoing connections
                const outConns = connections.filter(c => c.fromNode === conn.fromNode);
                const share = source.outgoingRPS / Math.max(1, outConns.length);
                
                passIncoming[conn.toNode] += share;
            });
            
            // Apply loads to nodes and compute outgoing rates for the next pass
            for (const id in nodes) {
                const node = nodes[id];
                if (node.type === 'traffic') continue; // Traffic sources keep their constant rates
                
                node.incomingRPS = passIncoming[id];
                
                if (node.status === 'outage') {
                    node.outgoingRPS = 0;
                    node.droppedRPS = node.incomingRPS;
                } else {
                    // Outgoing is limited by node's capacity
                    node.outgoingRPS = Math.min(node.incomingRPS, node.capacity);
                    node.droppedRPS = Math.max(0, node.incomingRPS - node.capacity);
                }
            }
        }
        
        // 4. Update Node Status, Latencies and Utilizations
        let totalSystemRPS = 0;
        for (const id in nodes) {
            const node = nodes[id];
            
            // Calculate active utilization percentage
            if (node.type === 'traffic') {
                node.utilization = 100;
                totalSystemRPS = Math.max(totalSystemRPS, node.rps || 1000);
            } else if (node.type === 's3') {
                // Storage has infinite capacity
                node.utilization = Math.min(100, (node.incomingRPS / 10000) * 100);
                node.status = node.status === 'outage' ? 'outage' : 'healthy';
            } else {
                node.utilization = node.capacity > 0 ? (node.incomingRPS / node.capacity) * 100 : 0;
                
                if (node.status !== 'outage') {
                    if (node.utilization > 100) {
                        node.status = 'bottleneck'; // Overloaded
                    } else {
                        node.status = 'healthy';
                    }
                }
            }
            
            // Calculate dynamic latency based on node load
            node.latency = this.calculateNodeLatency(node);
        }
        
        this.peakRPS = totalSystemRPS;
        this.app.dashboard.updateMetrics();
        this.app.requestRedraw();
    }

    calculateNodeCapacity(node) {
        if (node.status === 'outage') return 0;
        
        const replicas = node.replicas || 1;
        
        switch (node.type) {
            case 'alb':
                return 15000; // ALBs handle a lot of requests
            case 'ec2':
                const ec2Capacities = {
                    't3.micro': 1000,
                    'm5.large': 4000,
                    'c6g.2xlarge': 12000
                };
                return (ec2Capacities[node.size || 't3.micro']) * replicas;
            case 'rds':
                const rdsCapacities = {
                    'db.t3.micro': 800,
                    'db.m5.large': 3500,
                    'db.r6g.2xlarge': 10000
                };
                return (rdsCapacities[node.size || 'db.t3.micro']) * replicas;
            case 'lambda':
                return 8000; // High concurrency capacity
            case 'redis':
                return 20000; // Very high cache throughput
            case 's3':
                return 999999; // Infinite for our simulator
            default:
                return 1000;
        }
    }

    calculateNodeLatency(node) {
        if (node.status === 'outage') return 9999; // Outage latency
        
        let baseLatency = 2; // base 2ms
        switch (node.type) {
            case 'ec2': baseLatency = 15; break;
            case 'rds': baseLatency = 45; break;
            case 'lambda': baseLatency = 30; break;
            case 'redis': baseLatency = 1; break;
            case 's3': baseLatency = 8; break;
        }
        
        // Load multiplier: latency scales non-linearly as utilization exceeds 80%
        const util = node.utilization || 0;
        if (util > 80) {
            const multiplier = 1 + Math.pow((util - 80) / 10, 2); // Exponential latency spike
            return baseLatency * multiplier;
        }
        
        return baseLatency;
    }

    // Spawn animated packet particles proportional to active connections traffic load
    spawnPackets() {
        const now = Date.now();
        const connections = this.app.connections;
        const nodes = this.app.nodes;
        
        connections.forEach((conn, index) => {
            const source = nodes[conn.fromNode];
            const target = nodes[conn.toNode];
            if (!source || !target) return;
            
            // Calculate active connection flow
            const outConns = connections.filter(c => c.fromNode === conn.fromNode);
            const connectionLoad = source.outgoingRPS / Math.max(1, outConns.length);
            
            if (connectionLoad <= 0) return;
            
            // Rate limit visual packet counts (1 packet corresponds to scaled load)
            // Visual spawn rate cap to maintain performance (60fps)
            const visualMultiplier = Math.min(10, Math.ceil(connectionLoad / 500));
            const spawnInterval = Math.max(100, 1000 / (connectionLoad / 200)); 
            
            const lastSpawn = this.lastSpawnTimes.get(index) || 0;
            if (now - lastSpawn >= spawnInterval) {
                // Spawn particle
                const isFailed = source.status === 'outage' || target.status === 'outage';
                const isOverloaded = source.status === 'bottleneck' || target.status === 'bottleneck';
                
                let packetColor = '#06b6d4'; // default cyan
                if (isFailed) packetColor = '#ef4444'; // red
                else if (isOverloaded) packetColor = '#f59e0b'; // amber
                
                this.activePackets.push({
                    id: 'pkt_' + Math.random().toString(36).substr(2, 9),
                    connIndex: index,
                    t: 0,
                    speed: 0.015, // Base transition speed
                    color: packetColor,
                    state: 'flowing',
                    alpha: 1.0,
                    size: 4 + Math.min(4, visualMultiplier / 2) // size depends on traffic weight
                });
                
                this.lastSpawnTimes.set(index, now);
                this.totalSentPackets++;
            }
        });
    }

    updatePackets() {
        // First spawn any new packet particles
        this.spawnPackets();
        
        const nodes = this.app.nodes;
        const connections = this.app.connections;
        
        this.activePackets.forEach(pkt => {
            const conn = connections[pkt.connIndex];
            if (!conn) {
                // Connection was deleted, force drop
                pkt.state = 'dropping';
                pkt.vx = (Math.random() - 0.5) * 2;
                pkt.vy = -Math.random() * 2;
                return;
            }
            
            const source = nodes[conn.fromNode];
            const target = nodes[conn.toNode];
            if (!source || !target) {
                pkt.state = 'dropping';
                pkt.vx = (Math.random() - 0.5) * 2;
                pkt.vy = -Math.random() * 2;
                return;
            }
            
            if (pkt.state === 'flowing') {
                // Slow down packet speed if bottleneck is encountered
                let speedMod = 1.0;
                if (target.status === 'bottleneck') speedMod = 0.3; // 70% speed penalty
                
                pkt.t += pkt.speed * speedMod;
                
                // Packets reaching destination
                if (pkt.t >= 1.0) {
                    if (target.status === 'outage') {
                        // Node is dead, packets crash and drop!
                        pkt.state = 'dropping';
                        const coords = this.getBezierCoords(pkt.connIndex, 1.0);
                        pkt.dropX = coords.x;
                        pkt.dropY = coords.y;
                        pkt.vx = (Math.random() - 0.5) * 3;
                        pkt.vy = -Math.random() * 3 - 1;
                    } else if (target.status === 'bottleneck' && Math.random() < (target.droppedRPS / target.incomingRPS)) {
                        // Node is overloaded, percentage of packets dropped (simulating 502 Bad Gateway)
                        pkt.state = 'dropping';
                        const coords = this.getBezierCoords(pkt.connIndex, 0.9);
                        pkt.dropX = coords.x;
                        pkt.dropY = coords.y;
                        pkt.vx = (Math.random() - 0.5) * 3;
                        pkt.vy = -Math.random() * 2;
                    } else {
                        // Successful arrival
                        pkt.state = 'arrived';
                        this.totalSuccessfulPackets++;
                    }
                }
            } else if (pkt.state === 'dropping') {
                // Apply gravity and horizontal speed friction
                pkt.dropX += pkt.vx;
                pkt.dropY += pkt.vy;
                pkt.vy += 0.15; // Gravity
                pkt.alpha -= 0.03; // Fade out
            }
        });
        
        // Remove dead packets
        this.activePackets = this.activePackets.filter(pkt => pkt.state === 'flowing' || (pkt.state === 'dropping' && pkt.alpha > 0));
        
        // Calculate Availability rating dynamically
        if (this.totalSentPackets > 0) {
            const rate = (this.totalSuccessfulPackets / this.totalSentPackets) * 100;
            // Introduce smoothing to avoid erratic UI shifts
            this.availability = this.availability * 0.95 + rate * 0.05;
        }
    }

    drawPackets(ctx) {
        this.activePackets.forEach(pkt => {
            ctx.save();
            ctx.fillStyle = pkt.color;
            ctx.globalAlpha = pkt.state === 'dropping' ? pkt.alpha : 1.0;
            
            // Draw glowing core
            ctx.shadowBlur = 8;
            ctx.shadowColor = pkt.color;
            
            ctx.beginPath();
            if (pkt.state === 'flowing') {
                const coords = this.getBezierCoords(pkt.connIndex, pkt.t);
                ctx.arc(coords.x, coords.y, pkt.size, 0, Math.PI * 2);
            } else if (pkt.state === 'dropping') {
                ctx.arc(pkt.dropX, pkt.dropY, pkt.size * 0.8, 0, Math.PI * 2);
            }
            ctx.fill();
            ctx.restore();
        });
    }

    getBezierCoords(connIndex, t) {
        const conn = this.app.connections[connIndex];
        if (!conn) return { x: 0, y: 0 };
        
        const fromNode = this.app.nodes[conn.fromNode];
        const toNode = this.app.nodes[conn.toNode];
        if (!fromNode || !toNode) return { x: 0, y: 0 };
        
        const w = 140; // nodeWidth
        const p1 = { x: fromNode.x + w / 2, y: fromNode.y };
        const p2 = { x: toNode.x - w / 2, y: toNode.y };
        
        const cp1x = p1.x + Math.abs(p2.x - p1.x) * 0.5;
        const cp2x = p2.x - Math.abs(p2.x - p1.x) * 0.5;
        
        // Cubic bezier formula
        const mt = 1 - t;
        return {
            x: mt * mt * mt * p1.x + 3 * mt * mt * t * cp1x + 3 * mt * t * t * cp2x + t * t * t * p2.x,
            y: mt * mt * mt * p1.y + 3 * mt * mt * t * p1.y + 3 * mt * t * t * p2.y + t * t * t * p2.y
        };
    }

    // Toggle Chaos Engineering Mode
    toggleChaosMode() {
        this.chaosActive = !this.chaosActive;
        const banner = document.getElementById('chaos-mode-banner');
        const btn = document.getElementById('btn-chaos');
        
        if (this.chaosActive) {
            btn.classList.add('btn-active-toggle');
            banner.style.display = 'flex';
            this.app.showToast("Chaos Engineering Mode Activated", "danger");
            
            // Run chaos events every 12 seconds
            this.chaosIntervalId = setInterval(() => this.triggerChaosEvent(), 12000);
        } else {
            btn.classList.remove('btn-active-toggle');
            banner.style.display = 'none';
            this.app.showToast("Chaos Engineering Mode Deactivated", "info");
            
            clearInterval(this.chaosIntervalId);
            this.chaosIntervalId = null;
            
            // Recover all nodes from chaos outage status
            for (const id in this.app.nodes) {
                const node = this.app.nodes[id];
                if (node.status === 'outage') {
                    this.app.recoverNode(id);
                }
            }
        }
    }

    triggerChaosEvent() {
        const nodeIds = Object.keys(this.app.nodes).filter(id => this.app.nodes[id].type !== 'traffic');
        const conns = this.app.connections;
        
        if (nodeIds.length === 0) return;
        
        const r = Math.random();
        
        if (r < 0.5) {
            // Trigger server outage
            const targetId = nodeIds[Math.floor(Math.random() * nodeIds.length)];
            const node = this.app.nodes[targetId];
            
            const desc = `Instance Outage: Server "${node.name}" crashed!`;
            this.app.collabClient.sendChaosEvent('outage', targetId, desc);
            this.app.showToast(`CHAOS: ${desc}`, "danger");
            this.triggerLocalOutage(targetId, 'outage');
        } 
        else if (r < 0.8 && conns.length > 0) {
            // Sever network link connection
            const randIndex = Math.floor(Math.random() * conns.length);
            const conn = conns[randIndex];
            const source = this.app.nodes[conn.fromNode];
            const target = this.app.nodes[conn.toNode];
            
            const desc = `Network Sever: Link severed between ${source.name} and ${target.name}!`;
            this.app.collabClient.sendChaosEvent('sever', randIndex, desc);
            this.app.showToast(`CHAOS: ${desc}`, "danger");
            
            this.app.connections.splice(randIndex, 1);
            this.app.saveLocalState();
            this.app.requestRedraw();
        } 
        else {
            // Injected Traffic Load Spike
            const trafficNodes = Object.values(this.app.nodes).filter(n => n.type === 'traffic');
            if (trafficNodes.length > 0) {
                const node = trafficNodes[Math.floor(Math.random() * trafficNodes.length)];
                const originalRps = node.rps || 1000;
                const spikeRps = Math.min(20000, originalRps * 2.5);
                
                const desc = `Traffic Spike: Traffic Generator "${node.name}" load surged to ${spikeRps} RPS!`;
                this.app.showToast(`CHAOS: ${desc}`, "warning");
                
                node.rps = spikeRps;
                this.app.saveLocalState();
                
                // Reset after 8s
                setTimeout(() => {
                    node.rps = originalRps;
                    this.app.saveLocalState();
                    this.app.showToast(`Traffic load on "${node.name}" stabilized.`, "info");
                }, 8000);
            }
        }
    }

    triggerLocalOutage(nodeId, type) {
        const node = this.app.nodes[nodeId];
        if (!node) return;
        
        node.status = 'outage';
        this.app.requestRedraw();
        this.app.showToast(`Outage triggered on ${node.name}`, "danger");
        
        // Auto inspector update if active
        if (this.app.selectedNodeId === nodeId) {
            this.app.dashboard.openInspector(nodeId);
        }
    }

    // Force inject manual traffic test via slider
    startTraffic(nodeId, rps, payloadSize, isLocal = true) {
        const node = this.app.nodes[nodeId];
        if (node && node.type === 'traffic') {
            node.rps = rps;
            this.app.requestRedraw();
            
            if (isLocal) {
                this.app.collabClient.sendTrafficInject(nodeId, rps, payloadSize);
            }
        }
    }
}

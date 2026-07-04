/**
 * Dashboard & Inspector Controller Module for SyncForge
 * Calculates AWS resources pricing, dynamic network path latency,
 * and handles inspector UI input binding and events.
 */

export class DashboardController {
    constructor(app) {
        this.app = app;
        
        // AWS pricing structures (monthly rates)
        this.prices = {
            ec2: {
                't3.micro': 7.50,
                'm5.large': 70.00,
                'c6g.2xlarge': 270.00
            },
            rds: {
                'db.t3.micro': 15.00,
                'db.m5.large': 140.00,
                'db.r6g.2xlarge': 540.00
            },
            alb: 18.00,
            lambda: 5.00, // base cost
            s3: 10.00,    // base cost
            redis: 12.00  // base cost
        };
        
        this.initUIEventListeners();
    }

    initUIEventListeners() {
        // Inspector UI changes
        const inspectName = document.getElementById('inspect-name');
        const inspectSize = document.getElementById('inspect-size');
        const inspectTrafficRps = document.getElementById('inspect-traffic-rps');
        const inspectReplicas = document.getElementById('inspect-replicas');
        const btnDeleteNode = document.getElementById('btn-delete-node');
        const btnSimulateFail = document.getElementById('btn-simulate-fail');
        
        inspectName.addEventListener('input', (e) => {
            const nodeId = this.app.selectedNodeId;
            if (nodeId && this.app.nodes[nodeId]) {
                this.app.nodes[nodeId].name = e.target.value;
                this.app.requestRedraw();
                this.app.saveLocalState();
            }
        });
        
        inspectSize.addEventListener('change', (e) => {
            const nodeId = this.app.selectedNodeId;
            if (nodeId && this.app.nodes[nodeId]) {
                this.app.nodes[nodeId].size = e.target.value;
                this.app.simulationEngine.propagateLoad(); // Re-trigger load calculations
                this.app.saveLocalState();
            }
        });
        
        inspectTrafficRps.addEventListener('input', (e) => {
            const nodeId = this.app.selectedNodeId;
            if (nodeId && this.app.nodes[nodeId]) {
                const val = parseInt(e.target.value);
                document.getElementById('inspect-traffic-val').textContent = `${val.toLocaleString()} RPS`;
                this.app.simulationEngine.startTraffic(nodeId, val, 1024, true);
                this.app.saveLocalState();
            }
        });
        
        inspectReplicas.addEventListener('input', (e) => {
            const nodeId = this.app.selectedNodeId;
            if (nodeId && this.app.nodes[nodeId]) {
                const val = parseInt(e.target.value);
                document.getElementById('inspect-replicas-val').textContent = `${val} Node${val > 1 ? 's' : ''}`;
                this.app.nodes[nodeId].replicas = val;
                this.app.simulationEngine.propagateLoad();
                this.app.saveLocalState();
            }
        });
        
        btnDeleteNode.addEventListener('click', () => {
            const nodeId = this.app.selectedNodeId;
            if (nodeId) {
                this.app.deleteNode(nodeId);
            }
        });
        
        btnSimulateFail.addEventListener('click', () => {
            const nodeId = this.app.selectedNodeId;
            if (nodeId && this.app.nodes[nodeId]) {
                const node = this.app.nodes[nodeId];
                if (node.status === 'outage') {
                    this.app.recoverNode(nodeId);
                } else {
                    this.app.failNode(nodeId);
                }
            }
        });
    }

    openInspector(nodeId) {
        const node = this.app.nodes[nodeId];
        if (!node) return;
        
        const panel = document.getElementById('inspector-panel');
        panel.style.display = 'flex';
        
        // Set standard fields
        document.getElementById('inspect-title').textContent = `${node.type.toUpperCase()} Inspector`;
        document.getElementById('inspect-name').value = node.name || '';
        
        // Hide all conditional inputs
        document.getElementById('inspect-section-size').style.display = 'none';
        document.getElementById('inspect-section-traffic').style.display = 'none';
        document.getElementById('inspect-section-replicas').style.display = 'none';
        
        // Configure fail simulator button text
        const btnFail = document.getElementById('btn-simulate-fail');
        if (node.status === 'outage') {
            btnFail.textContent = "Bring Server Back Online";
            btnFail.className = "btn btn-active-toggle";
        } else {
            btnFail.textContent = "Simulate Server Outage";
            btnFail.className = "btn btn-danger";
        }
        
        // Show conditional inputs based on type
        if (node.type === 'traffic') {
            btnFail.style.display = 'none'; // Traffic sources don't fail standardly
            const section = document.getElementById('inspect-section-traffic');
            section.style.display = 'block';
            
            const rps = node.rps || 1000;
            document.getElementById('inspect-traffic-rps').value = rps;
            document.getElementById('inspect-traffic-val').textContent = `${rps.toLocaleString()} RPS`;
        } else {
            btnFail.style.display = 'block';
            
            if (node.type === 'ec2' || node.type === 'rds') {
                document.getElementById('inspect-section-replicas').style.display = 'block';
                const rep = node.replicas || 1;
                document.getElementById('inspect-replicas').value = rep;
                document.getElementById('inspect-replicas-val').textContent = `${rep} Node${rep > 1 ? 's' : ''}`;
                
                const sizeSelect = document.getElementById('inspect-size');
                sizeSelect.innerHTML = '';
                
                const sizes = node.type === 'ec2' ? 
                    ['t3.micro', 'm5.large', 'c6g.2xlarge'] : 
                    ['db.t3.micro', 'db.m5.large', 'db.r6g.2xlarge'];
                
                sizes.forEach(sz => {
                    const opt = document.createElement('option');
                    opt.value = sz;
                    opt.textContent = `${sz} ($${this.getNodePricing({ type: node.type, size: sz, replicas: 1 })}/mo)`;
                    sizeSelect.appendChild(opt);
                });
                
                sizeSelect.value = node.size || sizes[0];
                document.getElementById('inspect-section-size').style.display = 'block';
            }
        }
        
        this.updateInspectorReadout(nodeId);
    }

    closeInspector() {
        document.getElementById('inspector-panel').style.display = 'none';
    }

    updateInspectorReadout(nodeId) {
        const node = this.app.nodes[nodeId];
        if (!node) return;
        
        document.getElementById('inspect-capacity').textContent = node.type === 's3' ? 'Infinite' : `${(node.capacity || 0).toLocaleString()} RPS`;
        document.getElementById('inspect-cost').textContent = `$${this.getNodePricing(node).toFixed(2)}/mo`;
        document.getElementById('inspect-utilization').textContent = `${Math.round(node.utilization || 0)}%`;
        document.getElementById('inspect-node-latency').textContent = node.status === 'outage' ? '∞ ms' : `${Math.round(node.latency || 0)}ms`;
    }

    // Dynamic metrics calculation
    updateMetrics() {
        const nodes = Object.values(this.app.nodes);
        
        // 1. Calculate Spend
        let totalSpend = 0;
        nodes.forEach(node => {
            totalSpend += this.getNodePricing(node);
        });
        document.getElementById('val-cost').innerHTML = `$${totalSpend.toFixed(2)}<span>/mo</span>`;
        
        // 2. Availability
        const avail = this.app.simulationEngine ? this.app.simulationEngine.availability : 100;
        const availText = document.getElementById('val-availability-text');
        const availBar = document.getElementById('bar-availability');
        
        if (availText && availBar) {
            const displayAvail = Math.min(100, Math.max(0, avail));
            availText.textContent = `${displayAvail.toFixed(2)}%`;
            availBar.style.width = `${displayAvail}%`;
            
            // Set alert class colors
            availBar.className = 'progress-bar';
            if (displayAvail > 99) {
                availBar.classList.add('success');
                availText.style.color = 'var(--color-success)';
            } else if (displayAvail > 90) {
                availBar.classList.add('warning');
                availText.style.color = 'var(--color-warning)';
            } else {
                availBar.classList.add('danger');
                availText.style.color = 'var(--color-danger)';
            }
        }
        
        // 3. Peak RPS
        const rps = this.app.simulationEngine ? this.app.simulationEngine.peakRPS : 0;
        document.getElementById('val-rps').innerHTML = `${rps.toLocaleString()}<span>RPS</span>`;
        
        // 4. End-to-End Latency
        const systemLat = this.calculatePathsLatency();
        document.getElementById('val-latency').innerHTML = `${systemLat}<span>ms</span>`;
        
        // 5. Update Inspector in real time if open
        if (this.app.selectedNodeId) {
            this.updateInspectorReadout(this.app.selectedNodeId);
        }
    }

    getNodePricing(node) {
        if (node.status === 'outage') {
            // Outages still cost money (servers are provisioned but failing!)
        }
        
        const replicas = node.replicas || 1;
        
        switch (node.type) {
            case 'ec2':
                return (this.prices.ec2[node.size || 't3.micro'] || 7.50) * replicas;
            case 'rds':
                return (this.prices.rds[node.size || 'db.t3.micro'] || 15.00) * replicas;
            case 'alb':
                return this.prices.alb;
            case 'lambda':
                // Scales with active traffic load
                const rps = node.incomingRPS || 0;
                const lambdasCost = 0.50 * rps; // $0.50 per RPS/mo scaled
                return this.prices.lambda + lambdasCost;
            case 's3':
                // Scales with storage capacity usage simulated
                return this.prices.s3 + (node.incomingRPS || 0) * 0.005;
            case 'redis':
                return this.prices.redis;
            case 'traffic':
            default:
                return 0;
        }
    }

    calculatePathsLatency() {
        const nodes = this.app.nodes;
        const connections = this.app.connections;
        const trafficNodes = Object.values(nodes).filter(n => n.type === 'traffic');
        
        if (trafficNodes.length === 0) return 0;
        
        let totalLatency = 0;
        let pathCount = 0;
        
        const dfs = (nodeId, currentLatency, visited) => {
            const node = nodes[nodeId];
            if (!node || visited.has(nodeId)) return;
            
            visited.add(nodeId);
            const nodeLat = node.latency || 0;
            const nextConns = connections.filter(c => c.fromNode === nodeId);
            
            if (nextConns.length === 0 || node.type === 's3') {
                // Reached a leaf node/sink
                totalLatency += currentLatency + nodeLat;
                pathCount++;
                return;
            }
            
            nextConns.forEach(c => {
                // Add 5ms for network fiber hops
                dfs(c.toNode, currentLatency + nodeLat + 5, new Set(visited));
            });
        };
        
        trafficNodes.forEach(n => {
            dfs(n.id, 0, new Set());
        });
        
        return pathCount > 0 ? Math.round(totalLatency / pathCount) : 0;
    }
}

/**
 * Main SyncForge Application Orchestrator
 * Integrates canvas engine, simulation layers, metrics dashboards,
 * real-time collaboration events, and manages the main application state.
 */

import { CanvasEngine } from './canvas.js';
import { SimulationEngine } from './simulation.js';
import { DashboardController } from './dashboard.js';
import { CollaborationClient } from './collaboration.js';
import { downloadTerraform } from './terraform.js';

class SyncForgeApp {
    constructor() {
        this.nodes = {};       // Node data store (id -> node)
        this.connections = []; // Connections list (from, to)
        
        this.selectedNodeId = null;
        this.redrawRequested = false;

        // Create directory src/ if not exists (done implicitly by write_to_file)
        
        // 1. Initialize Sub-modules
        this.collabClient = new CollaborationClient(this);
        this.canvasEngine = new CanvasEngine(this, document.getElementById('simulator-canvas'));
        this.simulationEngine = new SimulationEngine(this);
        this.dashboard = new DashboardController(this);

        this.initDragAndDrop();
        this.initHeaderButtons();
        
        // Register initial layout save state once websocket completes handshake
        setTimeout(() => {
            if (Object.keys(this.nodes).length === 0) {
                this.loadDefaultArchitecture();
            }
        }, 1000);
    }

    requestRedraw() {
        this.redrawRequested = true;
    }

    // Set up drag events for dragging nodes from infrastructure sidebar onto canvas
    initDragAndDrop() {
        const libraryItems = document.querySelectorAll('.library-item');
        const canvasContainer = document.getElementById('canvas-container');
        
        libraryItems.forEach(item => {
            item.addEventListener('dragstart', (e) => {
                const type = item.getAttribute('data-node-type');
                e.dataTransfer.setData('text/plain', type);
                e.dataTransfer.effectAllowed = 'copy';
            });
        });
        
        canvasContainer.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        
        canvasContainer.addEventListener('drop', (e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData('text/plain');
            if (type) {
                this.canvasEngine.handleNodeDrop(type, e.clientX, e.clientY);
            }
        });
    }

    initHeaderButtons() {
        document.getElementById('btn-undo').addEventListener('click', () => this.collabClient.undo());
        document.getElementById('btn-redo').addEventListener('click', () => this.collabClient.redo());
        
        document.getElementById('btn-clear').addEventListener('click', () => {
            if (confirm("Are you sure you want to clear the canvas?")) {
                this.nodes = {};
                this.connections = [];
                this.deselectNode();
                this.saveLocalState();
                this.requestRedraw();
                this.showToast("Canvas cleared", "info");
            }
        });
        
        document.getElementById('btn-coworkers').addEventListener('click', () => this.collabClient.toggleBots());
        document.getElementById('btn-chaos').addEventListener('click', () => this.simulationEngine.toggleChaosMode());
        document.getElementById('btn-export').addEventListener('click', () => {
            if (Object.keys(this.nodes).length === 0) {
                this.showToast("Canvas is empty. Add nodes to export.", "warning");
                return;
            }
            downloadTerraform(this.nodes, this.connections);
            this.showToast("Terraform configurations downloaded!", "success");
        });
        
        // Listen for keyboard shortcuts
        window.addEventListener('keydown', (e) => {
            if (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') {
                return; // Ignore shortcuts inside form fields
            }
            
            // Undo: Ctrl+Z or Cmd+Z
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
                e.preventDefault();
                this.collabClient.undo();
            }
            // Redo: Ctrl+Y / Cmd+Y or Ctrl+Shift+Z
            if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
                e.preventDefault();
                this.collabClient.redo();
            }
            // Delete key for selected node
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedNodeId) {
                e.preventDefault();
                this.deleteNode(this.selectedNodeId);
            }
        });
    }

    // Default template layout for new visitors
    loadDefaultArchitecture() {
        this.nodes = {
            'traffic_1': { id: 'traffic_1', type: 'traffic', name: 'User Traffic Source', x: -280, y: 0, rps: 3000, utilization: 100, status: 'healthy', latency: 0 },
            'alb_1': { id: 'alb_1', type: 'alb', name: 'App Load Balancer', x: -100, y: 0, utilization: 0, status: 'healthy', latency: 2 },
            'ec2_1': { id: 'ec2_1', type: 'ec2', name: 'Web Server Class', x: 80, y: -60, size: 't3.micro', replicas: 3, utilization: 0, status: 'healthy', latency: 15 },
            'redis_1': { id: 'redis_1', type: 'redis', name: 'Redis Cache Cluster', x: 80, y: 60, utilization: 0, status: 'healthy', latency: 1 },
            'rds_1': { id: 'rds_1', type: 'rds', name: 'MySQL DB Cluster', x: 260, y: 0, size: 'db.t3.micro', replicas: 1, utilization: 0, status: 'healthy', latency: 45 }
        };

        this.connections = [
            { id: 'conn_1', fromNode: 'traffic_1', toNode: 'alb_1' },
            { id: 'conn_2', fromNode: 'alb_1', toNode: 'ec2_1' },
            { id: 'conn_3', fromNode: 'alb_1', toNode: 'redis_1' },
            { id: 'conn_4', fromNode: 'ec2_1', toNode: 'rds_1' },
            { id: 'conn_5', fromNode: 'redis_1', toNode: 'rds_1' }
        ];

        this.saveLocalState();
        this.requestRedraw();
        this.showToast("Default architecture loaded", "info");
    }

    // Add node
    addNode(type, x, y, name = null) {
        const id = `${type}_${Math.random().toString(36).substr(2, 5)}`;
        
        let nodeName = name;
        if (!nodeName) {
            const typeCounts = Object.values(this.nodes).filter(n => n.type === type).length;
            const titles = {
                traffic: 'Traffic Source',
                alb: 'Load Balancer',
                ec2: 'Compute Server',
                rds: 'Database Node',
                lambda: 'Serverless Function',
                s3: 'Storage Bucket',
                redis: 'ElastiCache Redis'
            };
            nodeName = `${titles[type] || type} ${typeCounts + 1}`;
        }

        const newNode = {
            id, type, name: nodeName,
            x: Math.round(x),
            y: Math.round(y),
            status: 'healthy',
            utilization: 0,
            latency: 0
        };

        // Specific defaults
        if (type === 'traffic') newNode.rps = 2000;
        if (type === 'ec2') { newNode.size = 't3.micro'; newNode.replicas = 1; }
        if (type === 'rds') { newNode.size = 'db.t3.micro'; newNode.replicas = 1; }

        this.nodes[id] = newNode;
        this.saveLocalState();
        this.selectNode(id);
        this.requestRedraw();
        this.showToast(`Added ${nodeName}`, "success");
    }

    // Move node
    updateNodePosition(id, x, y) {
        if (this.nodes[id]) {
            this.nodes[id].x = Math.round(x);
            this.nodes[id].y = Math.round(y);
            
            // Ephemeral sync: send current positions to others without pushing to history stack
            this.collabClient.sendStateUpdate({
                nodes: this.nodes,
                connections: this.connections
            });
            this.requestRedraw();
        }
    }

    // Delete node
    deleteNode(id) {
        const node = this.nodes[id];
        if (!node) return;

        // 1. Remove node
        delete this.nodes[id];

        // 2. Remove all related connections
        this.connections = this.connections.filter(c => c.fromNode !== id && c.toNode !== id);

        // 3. Clear inspector selection if active
        if (this.selectedNodeId === id) {
            this.deselectNode();
        }

        this.saveLocalState();
        this.requestRedraw();
        this.showToast(`Deleted ${node.name}`, "info");
    }

    // Add connection
    addConnection(fromNode, toNode) {
        // Prevent duplicate connections
        const exists = this.connections.some(c => c.fromNode === fromNode && c.toNode === toNode);
        if (exists) {
            this.showToast("Connection already exists", "warning");
            return;
        }

        // Prevent loops or connections of same node
        if (fromNode === toNode) return;

        const id = `conn_${Math.random().toString(36).substr(2, 5)}`;
        this.connections.push({ id, fromNode, toNode });
        
        this.saveLocalState();
        this.requestRedraw();
        this.showToast("Nodes connected", "success");
    }

    // Outage triggers
    failNode(nodeId) {
        if (this.nodes[nodeId]) {
            this.nodes[nodeId].status = 'outage';
            this.simulationEngine.propagateLoad();
            this.saveLocalState();
            this.requestRedraw();
            this.showToast(`Outage triggered on ${this.nodes[nodeId].name}`, "danger");
        }
    }

    recoverNode(nodeId) {
        if (this.nodes[nodeId]) {
            this.nodes[nodeId].status = 'healthy';
            this.simulationEngine.propagateLoad();
            this.saveLocalState();
            this.requestRedraw();
            this.showToast(`${this.nodes[nodeId].name} recovered and online`, "success");
        }
    }

    // Selection
    selectNode(id) {
        this.selectedNodeId = id;
        this.dashboard.openInspector(id);
        this.requestRedraw();
    }

    deselectNode() {
        this.selectedNodeId = null;
        this.dashboard.closeInspector();
        this.requestRedraw();
    }

    // Save local modifications to push state stack
    saveLocalState() {
        this.collabClient.pushState({
            nodes: this.nodes,
            connections: this.connections
        });
        
        // Also run load propagation instantly to recalculate metrics
        if (this.simulationEngine) {
            this.simulationEngine.propagateLoad();
        }
    }

    // State loader (triggered by server or undo/redo events)
    loadState(state, pushToHistory = true) {
        if (!state) return;
        
        // Save to state store
        this.nodes = state.nodes || {};
        this.connections = state.connections || [];
        
        // Check if selected node still exists, else close inspector
        if (this.selectedNodeId && !this.nodes[this.selectedNodeId]) {
            this.deselectNode();
        } else if (this.selectedNodeId) {
            this.dashboard.openInspector(this.selectedNodeId);
        }
        
        if (pushToHistory) {
            this.collabClient.pushState({
                nodes: this.nodes,
                connections: this.connections
            });
        }
        
        if (this.simulationEngine) {
            this.simulationEngine.propagateLoad();
        }
        
        this.requestRedraw();
    }

    // Toast Utility
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        if (!container) return;
        
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        
        let icon = 'ℹ️';
        if (type === 'success') icon = '✅';
        else if (type === 'warning') icon = '⚠️';
        else if (type === 'danger') icon = '🔥';
        
        toast.innerHTML = `<span>${icon}</span> ${message}`;
        container.appendChild(toast);
        
        // Self destruct after 3.5s
        setTimeout(() => {
            toast.style.animation = 'toast-out 0.3s forwards';
            toast.addEventListener('animationend', () => {
                toast.remove();
            });
        }, 3200);
    }
}

// Global initialization
window.addEventListener('DOMContentLoaded', () => {
    window.app = new SyncForgeApp();
});

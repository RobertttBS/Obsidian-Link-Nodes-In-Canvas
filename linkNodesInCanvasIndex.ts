import {
	debounce,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	ItemView,
	Notice,
	Plugin, prepareFuzzySearch, setIcon,
	TFile
} from 'obsidian';
import { AllCanvasNodeData, NodeSide } from "./canvas";
import { CanvasEdgeData } from "obsidian/canvas";
import { around } from "monkey-around";
import { CanvasView } from './@types/Canvas'

export default class LinkNodesInCanvas extends Plugin {
	public patchedEdge: boolean; // flag to check if edge is patched

	async onload() {
		console.log('Loading Link Nodes In Canvas');
		this.registerCustomCommands();
		this.registerCanvasAutoLink();
	}

	registerCustomCommands() {
		this.addCommand({
			id: 'link-between-selection-nodes',
			name: 'Link Between Selection Nodes',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const canvasView = this.app.workspace.getActiveViewOfType(ItemView);
				if (canvasView?.getViewType() === "canvas") {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					if (!checking) {
						// @ts-ignore
						const canvas = canvasView.canvas;
						const selection = canvas.selection;
						const currentData = canvas.getData();
						// @ts-ignore
						const fileNodes = Array.from(selection).filter((node) => node?.filePath !== undefined);
						if (fileNodes.length === 0) return;

						const resolvedLinks = this.app.metadataCache.resolvedLinks;
						const allEdgesData: CanvasEdgeData[] = [];
						fileNodes.forEach((node) => {
							// @ts-ignore
							const allLinks = (Object.keys(resolvedLinks[node.filePath]) as Array<string>);
							for (let i = 0; i < fileNodes.length; i++) {
								// @ts-ignore
								if (allLinks.includes(fileNodes[i].filePath)) { 
									if (node !== fileNodes[i]) { // fileNodes[i] is linked to node
										const newEdge = this.createEdge(node, fileNodes[i]);

										// find if the edge already exists
										const existingEdgeIndex = currentData.edges.findIndex((edge: CanvasEdgeData) => 
											edge.fromNode === newEdge.fromNode && edge.toNode === newEdge.toNode
										);

										// if edge already exists, update the direction
										if (existingEdgeIndex !== -1) {
											const existingEdge = currentData.edges[existingEdgeIndex];
											existingEdge.fromSide = newEdge.fromSide;
											existingEdge.toSide = newEdge.toSide;
											continue;
										}

										allEdgesData.push(newEdge);
									}
								}
							}
						});

						currentData.edges = [
							...currentData.edges,
							...allEdgesData,
						];

						canvas.setData(currentData);
						canvas.requestSave();
					}

					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});
	}

	registerCanvasAutoLink() {
		const updateTargetNode = debounce(async (e: any) => {
			if (!e.to.node.filePath) return;
			if (!e.from.node?.filePath && !Object.hasOwn(e.from.node, 'text')) return;

			const file = this.app.vault.getFileByPath(e.to.node.filePath);
			if (!file) return;

			const link = this.app.fileManager.generateMarkdownLink(file, e.canvas.view.file.path);

			if (e.from.node.filePath) {
				const fromFile = this.app.vault.getFileByPath(e.from.node.filePath);
				if (!fromFile) return;

				this.app.fileManager.processFrontMatter(fromFile, (frontmatter) => {
					if (!frontmatter.related) {
						frontmatter.related = [];
					}
					if (!Array.isArray(frontmatter.related)) {
						frontmatter.related = [frontmatter.related];
					}
					if (!frontmatter.related.includes(link)) {
						frontmatter.related.push(link);
					}
				});
			}
		}, 1000);

		const updateOriginalNode = async (canvas: any, edge: any) => {
			if (!edge.to.node.filePath) return;
			if (!edge.from.node?.filePath && !Object.hasOwn(edge.from.node, 'text')) return;

			const toNode = edge.to.node;
			const fromNode = edge.from.node;

			const file = this.app.vault.getFileByPath(toNode.filePath);
			if (!file) return;

			const link = this.app.fileManager.generateMarkdownLink(file, edge.to.node.filePath);

			if (fromNode?.filePath) {
				const fromFile = this.app.vault.getFileByPath(fromNode.filePath);
				if (!fromFile) return;

				this.app.fileManager.processFrontMatter(fromFile, (frontmatter) => {
					if (!frontmatter || !frontmatter.related) return;
			
					if (!Array.isArray(frontmatter.related)) {
						frontmatter.related = [frontmatter.related];
					}
			
					frontmatter.related = frontmatter.related.filter(l => l !== link);
			
					if (frontmatter.related.length === 0) {
						delete frontmatter.related;
					}
				});
			}
		};

		const selfPatched = (edge: any) => {
			this.patchedEdge = true;

			around(edge.constructor.prototype, {
				update: (next: any) => {
					return function (...args: any[]) {
						const result = next.call(this, ...args);
						updateTargetNode(this);
						return result;
					};
				}
			});
		};

		const self = this;

		const patchCanvas = () => {
			const canvasView = this.app.workspace.getLeavesOfType('canvas')[0]?.view;
			if (!canvasView) return false;

			// @ts-ignore
			const canvas = canvasView.canvas;
			if (!canvas) return false;

			const edge = canvas.edges.values().next().value;
			if (edge) { // if edge exists, patch it.
				this.patchedEdge = true;
				selfPatched(edge);
			}

			around(canvas.constructor.prototype, {
				removeEdge: (next: any) => {
					return function (edge: any) {
						const result = next.call(this, edge);
						if (this.isClearing !== true) {
							updateOriginalNode(this, edge);
						}
						return result;
					};
				}
			});

			around(canvas.constructor.prototype, {
				addEdge: (next: any) => {
					return function (edge: any) {
						const result = next.call(this, edge);
						if (!self.patchedEdge) {
							selfPatched(edge);
						}
						return result;
					};
				},
			});

			around(canvas.constructor.prototype, {
				clear: (next: any) => {
					return function () {
						this.isClearing = true;
						const result = next.call(this);
						this.isClearing = false;
						return result;
					};
				},
			});

			console.log('patch canvas success');
		};

		this.app.workspace.onLayoutReady(() => {
			if (!patchCanvas()) {
				const evt = this.app.workspace.on("layout-change", () => {
					patchCanvas() && this.app.workspace.offref(evt);
				});
				this.registerEvent(evt);
			}
		});
	}

	createEdge(node1: any, node2: any) {
		const random = (e: number) => {
			let t = [];
			for (let n = 0; n < e; n++) {
				t.push((16 * Math.random() | 0).toString(16));
			}
			return t.join("");
		};

		// compute angle between two nodes
		const angle = Math.atan2(node2.y - node1.y, node2.x - node1.x) * 180 / Math.PI;
    
		// determine the side of the node to connect
		let fromSide: NodeSide;
		let toSide: NodeSide;
		
		if (Math.abs(angle) <= 45) {
			fromSide = 'right';
			toSide = 'left';
		} else if (angle > 45 && angle <= 135) {
			fromSide = 'bottom';
			toSide = 'top';
		} else if (Math.abs(angle) > 135) {
			fromSide = 'left';
			toSide = 'right';
		} else {
			fromSide = 'top';
			toSide = 'bottom';
		}
	
		const edgeData: CanvasEdgeData = {
			id: random(16),
			fromSide,
			fromNode: node1.id,
			toSide,
			toNode: node2.id
		};
	
		return edgeData;
	}

	onunload() {
	}
}
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
	public patchedEdge: boolean;

	async onload() {
		console.log('Loading Link Nodes In Canvas');
		this.registerCustomCommands();
		// this.registerCustomSuggester();
		this.registerCanvasAutoLink();

		// this.registerFileModifyHandler();
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

	registerCustomSuggester() {
		this.registerEditorSuggest(new NodeSuggest(this));
	}

	// private registerFileModifyHandler() {
	// 	this.registerEvent(
	// 		this.app.vault.on('modify', async (file: TFile) => {
	// 			const canvases = this.app.workspace.getLeavesOfType('canvas')
	// 				.map(leaf => (leaf.view as CanvasView).canvas);
	
	// 			for (const canvas of canvases) {
	// 				if (canvas === undefined) continue;
					
	// 				const currentData = canvas.getData();
	// 				let needsUpdate = false;
					
	// 				currentData.nodes.forEach(nodeData => {
	// 					if ((nodeData.type === 'file' && nodeData.file === file.path) || 
	// 						(nodeData.type === 'file' && nodeData.portalToFile === file.path)) {
							
	// 						const node = canvas.nodes.get(nodeData.id);
	// 						if (node) {
	// 							node.isDirty = true;
	// 							needsUpdate = true;
	// 						}
	// 					}
	// 				});
	
	// 				if (needsUpdate) {
	// 					canvas.setData(currentData);
	
	// 					canvas.history.current--;
	// 					canvas.history.data.pop();
	// 				}
	// 			}
	// 		})
	// 	);
	// }

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
			if (edge) {
				this.patchedEdge = true;
				selfPatched(edge);

				around(canvas.constructor.prototype, {
					removeEdge: (next: any) => {
						return function (edge: any) {
							const result = next.call(this, edge);
							updateOriginalNode(this, edge);
							return result;
						};
					}
				});
				return true;
			}

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
				// deleteEdge: (next: any) => {
				// 	return function (edge: any) {
				// 		const result = next.call(this, edge);
				// 		updateOriginalNode(this, edge);
				// 		return result;
				// 	};
				// }
			});

			console.log('Canvas patched');
		};

		this.app.workspace.onLayoutReady(() => {
			if (!patchCanvas()) {
				new Notice('Canvas auto-link is not enabled');
				// const evt = this.app.workspace.on("layout-change", () => {
				// 	patchCanvas() && this.app.workspace.offref(evt);
				// 	new Notice('Layout-Change: Canvas auto-link enabled');
				// });
				// this.registerEvent(evt);
			}

			new Notice('Canvas auto-link enabled');
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

	updateFrontmatter(fromFile: TFile, link: string): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!fromFile) {
				new Notice(`Error: The provided file (fromFile) is undefined.`);
				return reject(new Error("fromFile is undefined"));
			}
	
			this.app.vault.read(fromFile)
				.then((content) => {
					if (content.includes(link)) {
						new Notice(`The link "${link}" is already included in the file's content.`);
						return resolve();
					}
	
					const frontmatterRegex = /^---\n([\s\S]*?)\n---/;
					const match = content.match(frontmatterRegex);
	
					let newContent;
					if (match) {
						const frontmatter = match[1];
						const relatedRegex = /related:\s*\[(.*)\]/;
						const relatedMatch = frontmatter.match(relatedRegex);
	
						if (relatedMatch) {
							const relatedLinks = relatedMatch[1]
								.split(',')
								.map((s) => s.trim())
								.filter((s) => s.length > 0);
	
							if (!relatedLinks.includes(`"${link}"`)) {
								relatedLinks.push(`"${link}"`);
								const newFrontmatter = frontmatter.replace(
									relatedRegex,
									`related: [${relatedLinks.join(', ')}]`
								);
								newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
							} else {
								new Notice(`The link "${link}" is already present in the related field.`);
							}
						} else {
							const newFrontmatter = `${frontmatter}\nrelated: ["${link}"]`;
							newContent = content.replace(frontmatterRegex, `---\n${newFrontmatter}\n---`);
						}
					} else {
						newContent = `---\nrelated: ["${link}"]\n---\n\n${content}`;
					}
	
					if (newContent && newContent !== content) {
						this.app.vault.modify(fromFile, newContent)
							.then(() => {
								resolve();
							})
							.catch((error) => {
								new Notice(`Error: Failed to update the file "${fromFile.path}". Check console for details.`);
								reject(error);
							});
					} else {
						new Notice(`No changes were made to the file: ${fromFile.path}`);
						resolve();
					}
				})
				.catch((error) => {
					new Notice(`Error: Failed to read the file "${fromFile.path}". Check console for details.`);
					reject(error);
				});
		});
	}

	async createEdgeBasedOnNodes(node1: any, node2: any, canvas: any, side: NodeSide) {
		const random = (e: number) => {
			let t = [];
			for (let n = 0; n < e; n++) {
				t.push((16 * Math.random() | 0).toString(16));
			}
			return t.join("");
		};
		let tempEdge: any;
		let fromTargetSide: NodeSide;
		let toTargetSide: NodeSide;

		switch (side) {
			case "left":
				fromTargetSide = "left";
				toTargetSide = "right";
				break;
			case "right":
				fromTargetSide = "right";
				toTargetSide = "left";
				break;
			case "top":
				fromTargetSide = "top";
				toTargetSide = "bottom";
				break;
			case "bottom":
				fromTargetSide = "bottom";
				toTargetSide = "top";
				break;
			case "top-left":
				fromTargetSide = "top";
				toTargetSide = "right";
				break;
			case "top-right":
				fromTargetSide = "top";
				toTargetSide = "left";
				break;
			case "bottom-left":
				fromTargetSide = "bottom";
				toTargetSide = "right";
				break;
			case "bottom-right":
				fromTargetSide = "bottom";
				toTargetSide = "left";
				break;
		}

		tempEdge = {
			id: random(16),
			fromSide: fromTargetSide,
			fromNode: node1.id,
			toSide: toTargetSide,
			toNode: node2.id
		};

		// let fromFile = this.app.vault.getFileByPath(node1.filePath);
		// let toFile = this.app.vault.getFileByPath(node2.filePath);
		// if (!fromFile || !toFile) return;

		// const toLink = this.app.fileManager.generateMarkdownLink(toFile, node2.filePath);

		// let content = this.app.vault.read(fromFile);

		// this.app.fileManager.processFrontMatter(fromFile, (frontmatter) => {
		// 	if (!frontmatter.related) {
		// 		frontmatter.related = [];
		// 	}
		// 	if (!Array.isArray(frontmatter.related)) {
		// 		frontmatter.related = [frontmatter.related];
		// 	}
		// 	if (!frontmatter.related.includes(toLink)) {
		// 		frontmatter.related.push(toLink);
		// 	}
		// });

		// const portalNode = node1;
		// const portalNodeData = portalNode.getData()
		// portalNode.setData({
		//   ...portalNodeData,
		//   portalToFile: portalNodeData.file
		// })
		// canvas.setData(canvas.getData());


		const currentData = canvas.getData();

		if (currentData.edges.some((edge: CanvasEdgeData) => {
			return edge.fromNode === tempEdge.fromNode && edge.toNode === tempEdge.toNode;
		})) {
			new Notice("Edge already exists between nodes");
			return;
		}

		currentData.edges = [
			...currentData.edges,
			tempEdge,
		];

		canvas.setData(currentData);
		canvas.requestSave();
	}


	onunload() {

	}
}


class NodeSuggest extends EditorSuggest<AllCanvasNodeData> {
	private plugin: LinkNodesInCanvas;
	private original: any;
	private target: any;

	private nodes: AllCanvasNodeData[] = [];
	private canvas: any;

	private fuzzySearch: ReturnType<typeof prepareFuzzySearch>;
	private end: number | undefined;
	private lineContents: string;

	constructor(plugin: LinkNodesInCanvas) {
		super(plugin.app);
		this.plugin = plugin;

		this.setInstructions([
			{
				command: 'Ctrl/Cmd + Enter',
				purpose: 'Link to node and generate link',
			}
		]);

		this.scope.register(['Mod'], 'Enter', (evt) => {
			evt.preventDefault();

			// @ts-ignore
			this.suggestions.useSelectedItem(evt);
		});
	}

	getNodes(): AllCanvasNodeData[] {
		const canvasView = this.plugin.app.workspace.getActiveViewOfType(ItemView);

		if (canvasView?.getViewType() === "canvas") {
			// @ts-ignore
			this.canvas = canvasView.canvas;
			// @ts-ignore
			const nodes = this.canvas.getData().nodes;

			return Array.from(nodes.values());
		}
		return [];
	}

	onTrigger(
		cursor: EditorPosition,
		editor: Editor,
		_: TFile
	): EditorSuggestTriggerInfo | null {
		this.lineContents = editor.getLine(cursor.line).toLowerCase();
		const before = this.lineContents.slice(0, cursor.ch);
		const after = this.lineContents.slice(cursor.ch);
		this.end = after.indexOf("}}");

		const firstIndex = before.lastIndexOf("{{");
		const lastIndex = before.lastIndexOf("}}");

		if (!(firstIndex > lastIndex && lastIndex === -1)) return null;

		const query = before.slice(firstIndex + 2);
		this.nodes = this.getNodes();

		this.original = Array.from(this.canvas.selection)[0];


		return {
			end: cursor,
			start: {
				ch: firstIndex,
				line: cursor.line,
			},
			query: query,
		};
	}

	getSuggestions(context: EditorSuggestContext): AllCanvasNodeData[] {
		const query = context.query.toLowerCase() || "";
		this.fuzzySearch = prepareFuzzySearch(query);

		const results = this.nodes.filter((node) => {
			switch (node.type) {
				case "text":
					if (node.id === this.original.id || node.text.trim() === "") return false;
					return this.fuzzySearch(node.text.toLowerCase());
				case "file":
					return this.fuzzySearch(node.file.toLowerCase());
				case "group":
					if (node.label?.trim()) return this.fuzzySearch(node.label?.toLowerCase());
					else return false;
				case "link":
					if (node.url.trim().length === 0) return false;
					return this.fuzzySearch(node.url.toLowerCase());
			}
		});

		return results;
	}

	renderSuggestion(suggestion: AllCanvasNodeData, el: HTMLElement): void {
		let outer: HTMLElement;
		let iconEl: HTMLElement;
		outer = el.createDiv({cls: "ltn-suggester-container"});
		switch (suggestion.type) {
			case "text":
				iconEl = outer.createDiv({cls: "ltn-suggester-icon"});
				setIcon(iconEl, "sticky-note");
				outer.createDiv({cls: "ltn-text-node"}).setText(`${suggestion.text}`);
				break;
			case "file":
				iconEl = outer.createDiv({cls: "ltn-suggester-icon"});
				setIcon(iconEl, "file-text");
				outer.createDiv({cls: "ltn-file-node"}).setText(`${suggestion.file}`);
				break;
			case "group":
				iconEl = outer.createDiv({cls: "ltn-suggester-icon"});
				setIcon(iconEl, "box-select");
				outer.createDiv({cls: "ltn-group-node"}).setText(`${suggestion.label}`);
				break;
			case "link":
				iconEl = outer.createDiv({cls: "ltn-suggester-icon"});
				setIcon(iconEl, "link");
				outer.createDiv({cls: "ltn-link-node"}).setText(`${suggestion.url}`);
				break;
		}

	}

	selectSuggestion(suggestion: AllCanvasNodeData, evt: MouseEvent | KeyboardEvent): void {
		if (this.context) {
	
			const editor = (this.context.editor as Editor);
			const updatedText = (evt.ctrlKey || evt.metaKey) && suggestion.type === 'file' ? `[[${suggestion.file}]]` : '';
			editor.replaceRange(
				updatedText,
				this.context.start,
				this.end === 0
					? {
						ch: this.context.end.ch + 2, // 吃掉 `}}`
						line: this.context.end.line,
					}
					: this.context.end
			);
	
			editor.setCursor({
				line: this.context.end.line,
				ch: this.context.end.ch + updatedText?.length - 2,
			});
	
			const targetNode = this.canvas.nodes.get(suggestion.id);
			const side = this.getDirectionText(this.original.x, this.original.y, targetNode.x, targetNode.y);
	
			this.plugin.createEdgeBasedOnNodes(this.original, targetNode, this.canvas, side);
			this.close();


			new Notice(`Closed`);
		}

		const targetNode = this.canvas.nodes.get(suggestion.id);
		const side = this.getDirectionText(this.original.x, this.original.y, targetNode.x, targetNode.y);

		this.plugin.createEdgeBasedOnNodes(this.original, targetNode, this.canvas, side);
	}
	

	getDirectionText(originalX: number, originalY: number, targetX: number, targetY: number): NodeSide {
		const x = originalX - targetX;
		const y = originalY - targetY;
		const angle = Math.atan2(y, x) * 180 / Math.PI;
		const direction = Math.round((angle + 180) / 45) % 8;

		switch (direction) {
			case 0:
				return "right";
			case 1:
				return "bottom-right";
			case 2:
				return "bottom";
			case 3:
				return "bottom-left";
			case 4:
				return "left";
			case 5:
				return "top-left";
			case 6:
				return "top";
			case 7:
				return "top-right";
			default:
				return "right";
		}
	}
}
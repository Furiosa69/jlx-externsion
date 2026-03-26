import * as extensionConfig from '../extension.json';

const EXTENSION_TITLE = '丝印生成器';
const STORAGE_KEYS = {
	silkFontFamily: 'silkscreenGenerator.fontFamily',
	silkFontSize: 'silkscreenGenerator.fixedFontSize',
	silkGeneratedTextIds: 'silkscreenGenerator.generatedTextIds',
} as const;

const DEFAULT_SILK_FONT_FAMILY = 'Default';
const DEFAULT_SILK_FONT_SIZE = 40;
const DEFAULT_SILK_CLEARANCE = 12;
const MAX_GENERATED_SILK_IDS = 400;

type SilkTextLayer = EPCB_LayerId.TOP_SILKSCREEN | EPCB_LayerId.BOTTOM_SILKSCREEN;

interface Point {
	x: number;
	y: number;
}

interface BoundingBox {
	maxX: number;
	maxY: number;
	minX: number;
	minY: number;
}

interface ComponentPadContext {
	center: Point;
	componentLayer: TPCB_LayersOfComponent;
}

interface PadGeometry {
	bbox: BoundingBox;
	x: number;
	y: number;
}

interface SilkCandidate {
	alignMode: EPCB_PrimitiveStringAlignMode;
	layer: SilkTextLayer;
	rotation: number;
	text: string;
	x: number;
	y: number;
}

interface SilkTextTarget {
	scopeLabel: string;
	texts: IPCB_PrimitiveString[];
}

export function activate(status?: 'onStartupFinished', arg?: string): void {
	void status;
	void arg;
}

export async function generateNetSilkscreen(): Promise<void> {
	if (!await ensurePcbContext('生成网络丝印')) {
		return;
	}

	const fontSize = getStoredSilkFontSize();
	const fontFamily = await getConfiguredSilkFontFamily();
	const selectedPrimitives = await eda.pcb_SelectControl.getAllSelectedPrimitives();
	const candidates = await buildSilkCandidatesFromSelection(selectedPrimitives, fontSize);

	if (candidates.length === 0) {
		showInformationMessage(
			[
				'请先在 PCB 中选中目标器件、器件焊盘或游离焊盘。',
				'生成器会读取这些焊盘绑定的网络名，并自动在对应丝印层创建文字。',
				'默认会过滤空网络、N$、Net-、unconnected、nc 这类自动命名网络。',
			].join('\n'),
		);
		return;
	}

	const createdTexts: IPCB_PrimitiveString[] = [];
	for (const candidate of candidates) {
		const created = await eda.pcb_PrimitiveString.create(
			candidate.layer,
			candidate.x,
			candidate.y,
			candidate.text,
			fontFamily,
			fontSize,
			buildSilkLineWidth(fontSize),
			candidate.alignMode,
			candidate.rotation,
			false,
			0,
			false,
			false,
		);

		if (created) {
			createdTexts.push(created);
		}
	}

	if (createdTexts.length === 0) {
		showInformationMessage('网络丝印创建失败，请检查当前 PCB 文档是否可编辑。');
		return;
	}

	await applyPadAvoidanceToTexts(createdTexts);
	await saveGeneratedSilkTextIds(createdTexts.map(text => text.getState_PrimitiveId()));
	showToast(`已生成 ${createdTexts.length} 个网络丝印，并完成焊盘避让。`);
}

export async function avoidSilkscreenPads(): Promise<void> {
	if (!await ensurePcbContext('一键避让焊盘')) {
		return;
	}

	const target = await resolveTargetSilkTexts();
	if (target.texts.length === 0) {
		showInformationMessage('当前没有可处理的丝印文字。请先选择丝印文字，或先执行“生成网络丝印”。');
		return;
	}

	const movedCount = await applyPadAvoidanceToTexts(target.texts);
	showToast(`已处理 ${target.scopeLabel}，调整 ${movedCount} 个丝印文字。`);
}

export async function unifySilkscreenTextDirection(): Promise<void> {
	if (!await ensurePcbContext('统一文字方向')) {
		return;
	}

	const target = await resolveTargetSilkTexts();
	if (target.texts.length === 0) {
		showInformationMessage('当前没有可处理的丝印文字。请先选择丝印文字，或先执行“生成网络丝印”。');
		return;
	}

	const updatedTexts: IPCB_PrimitiveString[] = [];
	for (const text of target.texts) {
		const updated = await text
			.toAsync()
			.setState_Rotation(getUnifiedRotation(text.getState_Layer()))
			.done();
		updatedTexts.push(updated);
	}

	await applyPadAvoidanceToTexts(updatedTexts);
	showToast(`已统一 ${target.scopeLabel} 的文字方向。`);
}

export async function setFixedSilkscreenFontSize(): Promise<void> {
	if (!await ensurePcbContext('设置固定字号')) {
		return;
	}

	const input = await showInputDialogAsync(
		'请输入固定字号',
		'该字号会被保存，并用于后续生成网络丝印；如果当前已有目标丝印，也会一并更新。',
		'设置固定字号',
		getStoredSilkFontSize(),
		{ min: 1, step: 1 },
	);
	if (input === undefined) {
		return;
	}

	const fontSize = Number(input);
	if (!Number.isFinite(fontSize) || fontSize <= 0) {
		showInformationMessage('字号必须是大于 0 的数字。');
		return;
	}

	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEYS.silkFontSize, fontSize);
	const target = await resolveTargetSilkTexts();
	if (target.texts.length === 0) {
		showToast(`已保存固定字号：${fontSize}`);
		return;
	}

	const updatedTexts: IPCB_PrimitiveString[] = [];
	for (const text of target.texts) {
		const updated = await text
			.toAsync()
			.setState_FontSize(fontSize)
			.setState_LineWidth(buildSilkLineWidth(fontSize))
			.done();
		updatedTexts.push(updated);
	}

	await applyPadAvoidanceToTexts(updatedTexts);
	showToast(`已将 ${target.scopeLabel} 设置为固定字号 ${fontSize}。`);
}

export async function setSilkscreenFontFamily(): Promise<void> {
	if (!await ensurePcbContext('设置字体')) {
		return;
	}

	const fonts = await eda.sys_FontManager.getFontsList().catch(() => [] as string[]);
	if (fonts.length === 0) {
		showInformationMessage('当前软件里没有可用字体。请先在软件字体管理里导入或启用字体后再试。');
		return;
	}

	const currentFont = await getConfiguredSilkFontFamily();
	const selectedFont = await showSelectDialogAsync(
		fonts,
		'选择丝印字体',
		'所选字体会保存为默认字体，并用于后续新生成的丝印。',
		'设置字体',
		fonts.includes(currentFont) ? currentFont : fonts[0],
	);
	if (!selectedFont) {
		return;
	}

	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEYS.silkFontFamily, selectedFont);
	const target = await resolveTargetSilkTexts();
	if (target.texts.length === 0) {
		showToast(`已保存默认字体：${selectedFont}`);
		return;
	}

	const updatedTexts: IPCB_PrimitiveString[] = [];
	for (const text of target.texts) {
		const updated = await text
			.toAsync()
			.setState_FontFamily(selectedFont)
			.done();
		updatedTexts.push(updated);
	}

	await applyPadAvoidanceToTexts(updatedTexts);
	showToast(`已将 ${target.scopeLabel} 设置为字体 ${selectedFont}。`);
}

export function about(): void {
	showInformationMessage(
		[
			`${EXTENSION_TITLE} v${extensionConfig.version}`,
			'根据选中焊盘自动生成网络丝印。',
			'支持不同字体、一键避让焊盘、统一文字方向、设置固定字号。',
			'请在 PCB 页面中使用。',
		].join('\n'),
	);
}

function showInformationMessage(content: string, title: string = EXTENSION_TITLE): void {
	eda.sys_Dialog.showInformationMessage(content, title, '确定');
}

function showToast(message: string): void {
	eda.sys_Message.showToastMessage(message);
}

async function ensurePcbContext(action: string): Promise<boolean> {
	const currentDocument = await eda.dmt_SelectControl.getCurrentDocumentInfo();
	if (currentDocument?.documentType === EDMT_EditorDocumentType.PCB) {
		return true;
	}

	showInformationMessage(`${action} 需要在 PCB 页面中执行，请切换到具体 PCB 后重试。`, '上下文不匹配');
	return false;
}

function getStoredSilkFontSize(): number {
	const value = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEYS.silkFontSize);
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
		return value;
	}
	if (typeof value === 'string' && value.length > 0) {
		const parsed = Number(value);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed;
		}
	}
	return DEFAULT_SILK_FONT_SIZE;
}

async function getConfiguredSilkFontFamily(): Promise<string> {
	const storedFont = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEYS.silkFontFamily);
	const fonts = await eda.sys_FontManager.getFontsList().catch(() => [] as string[]);

	if (typeof storedFont === 'string' && storedFont.length > 0 && (fonts.length === 0 || fonts.includes(storedFont))) {
		return storedFont;
	}

	const fallbackFont = fonts.includes(DEFAULT_SILK_FONT_FAMILY)
		? DEFAULT_SILK_FONT_FAMILY
		: (fonts[0] ?? DEFAULT_SILK_FONT_FAMILY);
	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEYS.silkFontFamily, fallbackFont);
	return fallbackFont;
}

async function saveGeneratedSilkTextIds(primitiveIds: string[]): Promise<void> {
	const compactIds = primitiveIds
		.filter(id => typeof id === 'string' && id.length > 0)
		.slice(-MAX_GENERATED_SILK_IDS);
	await eda.sys_Storage.setExtensionUserConfig(STORAGE_KEYS.silkGeneratedTextIds, JSON.stringify(compactIds));
}

function getStoredGeneratedSilkTextIds(): string[] {
	const storedValue = eda.sys_Storage.getExtensionUserConfig(STORAGE_KEYS.silkGeneratedTextIds);
	if (Array.isArray(storedValue)) {
		return storedValue.filter((value): value is string => typeof value === 'string' && value.length > 0);
	}
	if (typeof storedValue !== 'string' || storedValue.length === 0) {
		return [];
	}

	try {
		const parsed = JSON.parse(storedValue);
		return Array.isArray(parsed)
			? parsed.filter((value): value is string => typeof value === 'string' && value.length > 0)
			: [];
	}
	catch {
		return [];
	}
}

async function resolveTargetSilkTexts(): Promise<SilkTextTarget> {
	const selectedPrimitives = await eda.pcb_SelectControl.getAllSelectedPrimitives();
	const selectedTextIds = selectedPrimitives
		.filter(primitive => primitive.getState_PrimitiveType() === EPCB_PrimitiveType.STRING)
		.map(primitive => primitive.getState_PrimitiveId());

	if (selectedTextIds.length > 0) {
		const selectedTexts = filterSilkTexts(await eda.pcb_PrimitiveString.get(selectedTextIds));
		if (selectedTexts.length > 0) {
			return {
				scopeLabel: '选中丝印',
				texts: selectedTexts,
			};
		}
	}

	const generatedTextIds = getStoredGeneratedSilkTextIds();
	if (generatedTextIds.length > 0) {
		const generatedTexts = filterSilkTexts(await eda.pcb_PrimitiveString.get(generatedTextIds));
		if (generatedTexts.length > 0) {
			return {
				scopeLabel: '最近生成丝印',
				texts: generatedTexts,
			};
		}
	}

	const allTexts = filterSilkTexts([
		...await eda.pcb_PrimitiveString.getAll(EPCB_LayerId.TOP_SILKSCREEN),
		...await eda.pcb_PrimitiveString.getAll(EPCB_LayerId.BOTTOM_SILKSCREEN),
	]);
	return {
		scopeLabel: '当前 PCB 全部丝印',
		texts: allTexts,
	};
}

function filterSilkTexts(texts: IPCB_PrimitiveString[]): IPCB_PrimitiveString[] {
	return texts.filter(text => isSilkTextLayer(text.getState_Layer()));
}

async function buildSilkCandidatesFromSelection(
	selectedPrimitives: IPCB_Primitive[],
	fontSize: number,
): Promise<SilkCandidate[]> {
	const candidates: SilkCandidate[] = [];
	const seenCandidateKeys = new Set<string>();
	const componentContextCache = new Map<string, ComponentPadContext>();
	const netLayerCache = new Map<string, SilkTextLayer[]>();

	for (const primitive of selectedPrimitives) {
		const primitiveId = primitive.getState_PrimitiveId();
		switch (primitive.getState_PrimitiveType()) {
			case EPCB_PrimitiveType.COMPONENT: {
				const component = await eda.pcb_PrimitiveComponent.get(primitiveId);
				if (!component) {
					continue;
				}

				const context = await getComponentPadContext(component, componentContextCache);
				const pads = await component.getAllPins();
				for (const pad of pads) {
					await appendSilkCandidateFromPad(candidates, seenCandidateKeys, netLayerCache, pad, context, fontSize);
				}
				break;
			}
			case EPCB_PrimitiveType.COMPONENT_PAD: {
				const componentPad = await eda.pcb_Primitive.getPrimitiveByPrimitiveId(primitiveId) as IPCB_PrimitiveComponentPad | undefined;
				if (!componentPad) {
					continue;
				}

				const component = await eda.pcb_PrimitiveComponent.get(componentPad.getState_ParentComponentPrimitiveId());
				if (!component) {
					continue;
				}

				const context = await getComponentPadContext(component, componentContextCache);
				await appendSilkCandidateFromPad(candidates, seenCandidateKeys, netLayerCache, componentPad, context, fontSize);
				break;
			}
			case EPCB_PrimitiveType.PAD: {
				const pad = await eda.pcb_PrimitivePad.get(primitiveId);
				if (!pad) {
					continue;
				}

				await appendSilkCandidateFromPad(candidates, seenCandidateKeys, netLayerCache, pad, undefined, fontSize);
				break;
			}
			default:
				break;
		}
	}

	return candidates;
}

async function getComponentPadContext(
	component: IPCB_PrimitiveComponent,
	cache: Map<string, ComponentPadContext>,
): Promise<ComponentPadContext> {
	const primitiveId = component.getState_PrimitiveId();
	const cached = cache.get(primitiveId);
	if (cached) {
		return cached;
	}

	const pads = await component.getAllPins();
	const center = pads.length > 0
		? {
				x: pads.reduce((sum, pad) => sum + pad.getState_X(), 0) / pads.length,
				y: pads.reduce((sum, pad) => sum + pad.getState_Y(), 0) / pads.length,
			}
		: { x: component.getState_X(), y: component.getState_Y() };

	const context: ComponentPadContext = {
		center,
		componentLayer: component.getState_Layer(),
	};
	cache.set(primitiveId, context);
	return context;
}

async function appendSilkCandidateFromPad(
	candidates: SilkCandidate[],
	seenCandidateKeys: Set<string>,
	netLayerCache: Map<string, SilkTextLayer[]>,
	pad: IPCB_PrimitivePad,
	context: ComponentPadContext | undefined,
	fontSize: number,
): Promise<void> {
	const primitiveId = pad.getState_PrimitiveId();
	const netName = normalizeSilkNetName(pad.getState_Net());
	if (!netName) {
		return;
	}

	const layers = await resolveSilkLayersForNet(netName, pad.getState_Layer(), context?.componentLayer, netLayerCache);
	const padBox = estimatePadBoundingBox(pad);
	const padRadius = Math.max(padBox.maxX - padBox.minX, padBox.maxY - padBox.minY) / 2;
	const offset = padRadius + Math.max(fontSize * 0.9, 18);

	for (const layer of layers) {
		const candidateKey = `${primitiveId}:${layer}`;
		if (seenCandidateKeys.has(candidateKey)) {
			continue;
		}

		const direction = resolvePadEscapeDirection(pad, context?.center, layer);
		candidates.push({
			alignMode: EPCB_PrimitiveStringAlignMode.CENTER,
			layer,
			rotation: getAutoRotationFromDirection(direction),
			text: netName,
			x: pad.getState_X() + (direction.x * offset),
			y: pad.getState_Y() + (direction.y * offset),
		});
		seenCandidateKeys.add(candidateKey);
	}
}

function normalizeSilkNetName(netName?: string): string | undefined {
	if (typeof netName !== 'string') {
		return undefined;
	}

	const trimmed = netName.trim();
	if (trimmed.length === 0) {
		return undefined;
	}

	const ignoredPatterns = [/^N\$/i, /^Net-/i, /^unconnected/i, /^nc$/i];
	return ignoredPatterns.some(pattern => pattern.test(trimmed)) ? undefined : trimmed;
}

function resolveSilkLayer(
	padLayer: TPCB_LayersOfPad,
	componentLayer?: TPCB_LayersOfComponent,
): SilkTextLayer {
	if (componentLayer === EPCB_LayerId.BOTTOM || padLayer === EPCB_LayerId.BOTTOM) {
		return EPCB_LayerId.BOTTOM_SILKSCREEN;
	}
	return EPCB_LayerId.TOP_SILKSCREEN;
}

async function resolveSilkLayersForNet(
	netName: string,
	padLayer: TPCB_LayersOfPad,
	componentLayer: TPCB_LayersOfComponent | undefined,
	netLayerCache: Map<string, SilkTextLayer[]>,
): Promise<SilkTextLayer[]> {
	const fallbackLayer = resolveSilkLayer(padLayer, componentLayer);
	const cachedLayers = netLayerCache.get(netName);
	if (cachedLayers) {
		return mergeSilkLayers(cachedLayers, [fallbackLayer]);
	}

	const primitives = await eda.pcb_Net.getAllPrimitivesByNet(netName, [
		EPCB_PrimitiveType.ARC,
		EPCB_PrimitiveType.COMPONENT,
		EPCB_PrimitiveType.COMPONENT_PAD,
		EPCB_PrimitiveType.LINE,
		EPCB_PrimitiveType.PAD,
	]).catch(() => [] as IPCB_Primitive[]);
	const detectedLayers = detectSilkLayersFromNetPrimitives(primitives);
	netLayerCache.set(netName, detectedLayers);
	return detectedLayers.length > 0 ? mergeSilkLayers(detectedLayers, [fallbackLayer]) : [fallbackLayer];
}

function detectSilkLayersFromNetPrimitives(primitives: IPCB_Primitive[]): SilkTextLayer[] {
	const layers: SilkTextLayer[] = [];
	for (const primitive of primitives) {
		switch (primitive.getState_PrimitiveType()) {
			case EPCB_PrimitiveType.LINE:
				layers.push(...toSilkLayersFromLineLayer((primitive as IPCB_PrimitiveLine).getState_Layer()));
				break;
			case EPCB_PrimitiveType.ARC:
				layers.push(...toSilkLayersFromLineLayer((primitive as IPCB_PrimitiveArc).getState_Layer()));
				break;
			case EPCB_PrimitiveType.PAD:
			case EPCB_PrimitiveType.COMPONENT_PAD:
				layers.push(...toSilkLayersFromPadLayer((primitive as IPCB_PrimitivePad).getState_Layer()));
				break;
			case EPCB_PrimitiveType.COMPONENT:
				layers.push(...toSilkLayersFromComponentLayer((primitive as IPCB_PrimitiveComponent).getState_Layer()));
				break;
			default:
				break;
		}
	}
	return mergeSilkLayers(layers);
}

function toSilkLayersFromLineLayer(layer: TPCB_LayersOfLine): SilkTextLayer[] {
	if (layer === EPCB_LayerId.BOTTOM) {
		return [EPCB_LayerId.BOTTOM_SILKSCREEN];
	}
	if (layer === EPCB_LayerId.TOP) {
		return [EPCB_LayerId.TOP_SILKSCREEN];
	}
	return [];
}

function toSilkLayersFromPadLayer(layer: TPCB_LayersOfPad): SilkTextLayer[] {
	if (layer === EPCB_LayerId.MULTI) {
		return [EPCB_LayerId.TOP_SILKSCREEN, EPCB_LayerId.BOTTOM_SILKSCREEN];
	}
	return layer === EPCB_LayerId.BOTTOM
		? [EPCB_LayerId.BOTTOM_SILKSCREEN]
		: [EPCB_LayerId.TOP_SILKSCREEN];
}

function toSilkLayersFromComponentLayer(layer: TPCB_LayersOfComponent): SilkTextLayer[] {
	return layer === EPCB_LayerId.BOTTOM
		? [EPCB_LayerId.BOTTOM_SILKSCREEN]
		: [EPCB_LayerId.TOP_SILKSCREEN];
}

function mergeSilkLayers(...layerGroups: SilkTextLayer[][]): SilkTextLayer[] {
	const merged = new Set<SilkTextLayer>();
	for (const group of layerGroups) {
		for (const layer of group) {
			merged.add(layer);
		}
	}

	return Array.from(merged);
}

function resolvePadEscapeDirection(
	pad: IPCB_PrimitivePad,
	center: Point | undefined,
	layer: SilkTextLayer,
): Point {
	if (center) {
		const dx = pad.getState_X() - center.x;
		const dy = pad.getState_Y() - center.y;
		if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
			return normalizeVector({ x: dx, y: dy });
		}
	}

	const fallback = fallbackVectorFromRotation(pad.getState_Rotation());
	if (layer === EPCB_LayerId.BOTTOM_SILKSCREEN && fallback.x === 0 && fallback.y === 0) {
		return { x: 0, y: -1 };
	}
	return fallback;
}

function normalizeVector(vector: Point): Point {
	const length = Math.hypot(vector.x, vector.y);
	if (length < 0.001) {
		return { x: 1, y: 0 };
	}
	return {
		x: vector.x / length,
		y: vector.y / length,
	};
}

function fallbackVectorFromRotation(rotation: number): Point {
	const radians = (normalizeRotation(rotation) * Math.PI) / 180;
	const vector = normalizeVector({
		x: Number(Math.cos(radians).toFixed(4)),
		y: Number(Math.sin(radians).toFixed(4)),
	});
	return Math.abs(vector.x) < 0.001 && Math.abs(vector.y) < 0.001 ? { x: 1, y: 0 } : vector;
}

function normalizeRotation(rotation: number): number {
	const normalized = rotation % 360;
	return normalized < 0 ? normalized + 360 : normalized;
}

function getAutoRotationFromDirection(direction: Point): number {
	if (Math.abs(direction.x) >= Math.abs(direction.y)) {
		return direction.x >= 0 ? 0 : 180;
	}
	return direction.y >= 0 ? 90 : 270;
}

function buildSilkLineWidth(fontSize: number): number {
	return Math.max(4, Math.round(fontSize * 0.12));
}

async function applyPadAvoidanceToTexts(texts: IPCB_PrimitiveString[]): Promise<number> {
	if (texts.length === 0) {
		return 0;
	}

	const padMap = await collectPadGeometryByLayer(texts);
	let movedCount = 0;

	for (const text of texts) {
		const layer = toSilkTextLayer(text.getState_Layer());
		if (!layer) {
			continue;
		}

		const nextPoint = findClearTextPosition(text, padMap.get(layer) ?? []);
		if (!nextPoint) {
			continue;
		}

		await text
			.toAsync()
			.setState_X(nextPoint.x)
			.setState_Y(nextPoint.y)
			.done();
		movedCount += 1;
	}

	return movedCount;
}

async function collectPadGeometryByLayer(texts: IPCB_PrimitiveString[]): Promise<Map<SilkTextLayer, PadGeometry[]>> {
	const needTop = texts.some(text => text.getState_Layer() === EPCB_LayerId.TOP_SILKSCREEN);
	const needBottom = texts.some(text => text.getState_Layer() === EPCB_LayerId.BOTTOM_SILKSCREEN);

	const layerMap = new Map<SilkTextLayer, PadGeometry[]>([
		[EPCB_LayerId.TOP_SILKSCREEN, []],
		[EPCB_LayerId.BOTTOM_SILKSCREEN, []],
	]);

	if (needTop) {
		const topComponents = await eda.pcb_PrimitiveComponent.getAll(EPCB_LayerId.TOP);
		for (const component of topComponents) {
			const pads = await component.getAllPins();
			for (const pad of pads) {
				layerMap.get(EPCB_LayerId.TOP_SILKSCREEN)?.push(toPadGeometry(pad));
			}
		}

		const topPads = await eda.pcb_PrimitivePad.getAll(EPCB_LayerId.TOP);
		for (const pad of topPads) {
			layerMap.get(EPCB_LayerId.TOP_SILKSCREEN)?.push(toPadGeometry(pad));
		}
	}

	if (needBottom) {
		const bottomComponents = await eda.pcb_PrimitiveComponent.getAll(EPCB_LayerId.BOTTOM);
		for (const component of bottomComponents) {
			const pads = await component.getAllPins();
			for (const pad of pads) {
				layerMap.get(EPCB_LayerId.BOTTOM_SILKSCREEN)?.push(toPadGeometry(pad));
			}
		}

		const bottomPads = await eda.pcb_PrimitivePad.getAll(EPCB_LayerId.BOTTOM);
		for (const pad of bottomPads) {
			layerMap.get(EPCB_LayerId.BOTTOM_SILKSCREEN)?.push(toPadGeometry(pad));
		}
	}

	const multiPads = await eda.pcb_PrimitivePad.getAll(EPCB_LayerId.MULTI);
	for (const pad of multiPads) {
		if (needTop) {
			layerMap.get(EPCB_LayerId.TOP_SILKSCREEN)?.push(toPadGeometry(pad));
		}
		if (needBottom) {
			layerMap.get(EPCB_LayerId.BOTTOM_SILKSCREEN)?.push(toPadGeometry(pad));
		}
	}

	return layerMap;
}

function toPadGeometry(pad: IPCB_PrimitivePad): PadGeometry {
	return {
		bbox: expandBoundingBox(estimatePadBoundingBox(pad), DEFAULT_SILK_CLEARANCE),
		x: pad.getState_X(),
		y: pad.getState_Y(),
	};
}

function estimatePadBoundingBox(pad: IPCB_PrimitivePad): BoundingBox {
	const { height, width } = getPadDimensions(pad.getState_Pad());
	const rotation = normalizeRotation(pad.getState_Rotation());
	let halfWidth = width / 2;
	let halfHeight = height / 2;

	if (rotation % 90 !== 0) {
		const radius = Math.hypot(width, height) / 2;
		halfWidth = radius;
		halfHeight = radius;
	}
	else if (rotation % 180 !== 0) {
		halfWidth = height / 2;
		halfHeight = width / 2;
	}

	return {
		maxX: pad.getState_X() + halfWidth,
		maxY: pad.getState_Y() + halfHeight,
		minX: pad.getState_X() - halfWidth,
		minY: pad.getState_Y() - halfHeight,
	};
}

function getPadDimensions(padShape: TPCB_PrimitivePadShape | undefined): { height: number; width: number } {
	if (!padShape) {
		return { height: 32, width: 32 };
	}

	switch (padShape[0]) {
		case EPCB_PrimitivePadShapeType.ELLIPSE:
		case EPCB_PrimitivePadShapeType.OBLONG:
			return { height: padShape[2], width: padShape[1] };
		case EPCB_PrimitivePadShapeType.RECTANGLE:
			return { height: padShape[2], width: padShape[1] };
		case EPCB_PrimitivePadShapeType.REGULAR_POLYGON:
			return { height: padShape[1], width: padShape[1] };
		case EPCB_PrimitivePadShapeType.POLYLINE_COMPLEX_POLYGON:
		default:
			return { height: 48, width: 48 };
	}
}

function findClearTextPosition(text: IPCB_PrimitiveString, pads: PadGeometry[]): Point | undefined {
	if (pads.length === 0) {
		return undefined;
	}

	const originalPoint = { x: text.getState_X(), y: text.getState_Y() };
	const originalBox = expandBoundingBox(buildTextBoundingBox(text, originalPoint), DEFAULT_SILK_CLEARANCE / 2);
	const overlappingPads = pads.filter(pad => boxesIntersect(originalBox, pad.bbox));
	if (overlappingPads.length === 0) {
		return undefined;
	}

	const seedVector = normalizeVector(overlappingPads.reduce<Point>((accumulator, pad) => ({
		x: accumulator.x + (originalPoint.x - pad.x),
		y: accumulator.y + (originalPoint.y - pad.y),
	}), { x: 0, y: 0 }));
	const searchDirections = buildPreferredSearchDirections(seedVector);
	const stepDistance = Math.max(text.getState_FontSize() * 0.8, DEFAULT_SILK_CLEARANCE);

	for (let ring = 1; ring <= 18; ring += 1) {
		for (const direction of searchDirections) {
			const candidatePoint = {
				x: originalPoint.x + (direction.x * stepDistance * ring),
				y: originalPoint.y + (direction.y * stepDistance * ring),
			};
			const candidateBox = expandBoundingBox(buildTextBoundingBox(text, candidatePoint), DEFAULT_SILK_CLEARANCE / 2);
			const blocked = pads.some(pad => boxesIntersect(candidateBox, pad.bbox));
			if (!blocked) {
				return candidatePoint;
			}
		}
	}

	return undefined;
}

function buildPreferredSearchDirections(seed: Point): Point[] {
	const forward = normalizeVector(seed);
	const left = rotateVector90(forward);
	const right = invertVector(left);
	const backward = invertVector(forward);

	return [
		forward,
		normalizeVector({ x: forward.x + left.x, y: forward.y + left.y }),
		normalizeVector({ x: forward.x + right.x, y: forward.y + right.y }),
		left,
		right,
		backward,
		normalizeVector({ x: backward.x + left.x, y: backward.y + left.y }),
		normalizeVector({ x: backward.x + right.x, y: backward.y + right.y }),
	];
}

function rotateVector90(vector: Point): Point {
	return normalizeVector({ x: -vector.y, y: vector.x });
}

function invertVector(vector: Point): Point {
	return normalizeVector({ x: -vector.x, y: -vector.y });
}

function buildTextBoundingBox(text: IPCB_PrimitiveString, point: Point): BoundingBox {
	const rawWidth = estimateTextWidth(text.getState_Text(), text.getState_FontSize());
	const rawHeight = Math.max(text.getState_FontSize(), text.getState_LineWidth() * 2) * 1.1;
	const rotation = normalizeRotation(text.getState_Rotation());
	let width = rawWidth;
	let height = rawHeight;

	if (rotation % 90 !== 0) {
		const radius = Math.hypot(rawWidth, rawHeight) / 2;
		width = radius * 2;
		height = radius * 2;
	}
	else if (rotation % 180 !== 0) {
		width = rawHeight;
		height = rawWidth;
	}

	return alignBoundingBox(point, width, height, text.getState_AlignMode());
}

function alignBoundingBox(
	point: Point,
	width: number,
	height: number,
	alignMode: EPCB_PrimitiveStringAlignMode,
): BoundingBox {
	switch (alignMode) {
		case EPCB_PrimitiveStringAlignMode.LEFT_TOP:
			return { maxX: point.x + width, maxY: point.y + height, minX: point.x, minY: point.y };
		case EPCB_PrimitiveStringAlignMode.LEFT_MIDDLE:
			return { maxX: point.x + width, maxY: point.y + (height / 2), minX: point.x, minY: point.y - (height / 2) };
		case EPCB_PrimitiveStringAlignMode.LEFT_BOTTOM:
			return { maxX: point.x + width, maxY: point.y, minX: point.x, minY: point.y - height };
		case EPCB_PrimitiveStringAlignMode.CENTER_TOP:
			return { maxX: point.x + (width / 2), maxY: point.y + height, minX: point.x - (width / 2), minY: point.y };
		case EPCB_PrimitiveStringAlignMode.CENTER:
			return { maxX: point.x + (width / 2), maxY: point.y + (height / 2), minX: point.x - (width / 2), minY: point.y - (height / 2) };
		case EPCB_PrimitiveStringAlignMode.CENTER_BOTTOM:
			return { maxX: point.x + (width / 2), maxY: point.y, minX: point.x - (width / 2), minY: point.y - height };
		case EPCB_PrimitiveStringAlignMode.RIGHT_TOP:
			return { maxX: point.x, maxY: point.y + height, minX: point.x - width, minY: point.y };
		case EPCB_PrimitiveStringAlignMode.RIGHT_MIDDLE:
			return { maxX: point.x, maxY: point.y + (height / 2), minX: point.x - width, minY: point.y - (height / 2) };
		case EPCB_PrimitiveStringAlignMode.RIGHT_BOTTOM:
			return { maxX: point.x, maxY: point.y, minX: point.x - width, minY: point.y - height };
		default:
			return { maxX: point.x + (width / 2), maxY: point.y + (height / 2), minX: point.x - (width / 2), minY: point.y - (height / 2) };
	}
}

function estimateTextWidth(text: string, fontSize: number): number {
	let units = 0;
	for (const char of text) {
		if (/\s/.test(char)) {
			units += 0.35;
			continue;
		}
		if (/[\u3400-\u9FFF]/.test(char)) {
			units += 1;
			continue;
		}
		if (/[A-Z0-9]/.test(char)) {
			units += 0.7;
			continue;
		}
		if (/[a-z]/.test(char)) {
			units += 0.62;
			continue;
		}
		units += 0.8;
	}

	return Math.max(fontSize, units * fontSize * 0.78);
}

function expandBoundingBox(box: BoundingBox, padding: number): BoundingBox {
	return {
		maxX: box.maxX + padding,
		maxY: box.maxY + padding,
		minX: box.minX - padding,
		minY: box.minY - padding,
	};
}

function boxesIntersect(left: BoundingBox, right: BoundingBox): boolean {
	return !(left.maxX < right.minX || left.minX > right.maxX || left.maxY < right.minY || left.minY > right.maxY);
}

function getUnifiedRotation(layer: TPCB_LayersOfImage): number {
	return layer === EPCB_LayerId.BOTTOM_SILKSCREEN ? 180 : 0;
}

function isSilkTextLayer(layer: TPCB_LayersOfImage): layer is SilkTextLayer {
	return layer === EPCB_LayerId.TOP_SILKSCREEN || layer === EPCB_LayerId.BOTTOM_SILKSCREEN;
}

function toSilkTextLayer(layer: TPCB_LayersOfImage): SilkTextLayer | undefined {
	return isSilkTextLayer(layer) ? layer : undefined;
}

function showInputDialogAsync(
	beforeContent: string,
	afterContent: string,
	title: string,
	value: string | number,
	otherProperty?: {
		max?: number;
		maxlength?: number;
		min?: number;
		minlength?: number;
		multiple?: boolean;
		pattern?: RegExp;
		placeholder?: string;
		readonly?: boolean;
		step?: number;
	},
): Promise<string | undefined> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showInputDialog(
			beforeContent,
			afterContent,
			title,
			'number',
			value,
			otherProperty,
			(inputValue) => {
				resolve(typeof inputValue === 'string' || typeof inputValue === 'number' ? String(inputValue) : undefined);
			},
		);
	});
}

function showSelectDialogAsync(
	options: string[],
	beforeContent: string,
	afterContent: string,
	title: string,
	defaultOption: string,
): Promise<string | undefined> {
	return new Promise((resolve) => {
		eda.sys_Dialog.showSelectDialog(
			options,
			beforeContent,
			afterContent,
			title,
			defaultOption,
			false,
			(value) => {
				resolve(typeof value === 'string' && value.length > 0 ? value : undefined);
			},
		);
	});
}

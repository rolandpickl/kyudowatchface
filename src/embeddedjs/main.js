import Poco from "commodetto/Poco";
import parseBMF from "commodetto/parseBMF";
import parseRLE from "commodetto/parseRLE";
import Battery from "embedded:sensor/Battery";
import Debug from "debug";

const render = new Poco(screen);

const black = render.makeColor(0, 0, 0);
const white = render.makeColor(255, 255, 255);
const red = render.makeColor(255, 0, 0);
const green = render.makeColor(0, 180, 60);

/** 弓 (kyū) at 9 o'clock, 道 (dō) at 3 o'clock — 弓道 kyūdō */
const KANJI_KYU = "\u5f13";
const KANJI_DO = "\u9053";

function loadNotoSansJPDialFont() {
	const font = parseBMF(new Resource("NotoSansJP-Regular-24.fnt"));
	font.bitmap = parseRLE(new Resource("NotoSansJP-Regular-24-alpha.bm4"));
	return font;
}

const dialLabelFont = loadNotoSansJPDialFont();

const FRAME_COUNT = 6;
const FRAME_RESOURCE_IDS = [1, 2, 3, 4, 5, 6];

/**
 * If true: decode all kyudo PNGs once and keep them referenced — no allocation when the
 * 10s slot changes (less heap churn / fragmentation). Uses ~6× one frame in RAM.
 * If preloading OOMs at startup, set to false to keep only the current frame decoded.
 */
let batteryPercent = 100;
let batteryCharging = false;

const batteryReader = new Battery({});

const KYUDO_INTERVAL_SEC = 10;

let currentBitmap = null;
let cachedIdx = -1;

function getKyudoBitmap(idx) {
	if (idx === cachedIdx) return currentBitmap;
	// Drop old ref and force full GC so xs_Bitmap_destructor runs gbitmap_destroy
	// before we allocate the new GBitmap — deterministic, not dependent on GC timing.
	currentBitmap = null;
	cachedIdx = -1;
	Debug.gc();
	try {
		currentBitmap = new Poco.PebbleBitmap(FRAME_RESOURCE_IDS[idx]);
		cachedIdx = idx;
		return currentBitmap;
	} catch {
		return null;
	}
}

function frameIndexForTime(date) {
	const secs = date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
	return Math.floor(secs / KYUDO_INTERVAL_SEC) % FRAME_COUNT;
}

function drawBatteryBar(rw) {
	const margin = 100;
	const barH = 6;
	const barY = 26;
	const barW = rw - 2 * margin;
	const fill = Math.round(barW * batteryPercent / 100);
	const fillColor = batteryCharging ? white : (batteryPercent <= 20 ? red : green);

	render.fillRectangle(black, margin - 1, barY - 1, barW + 2, barH + 2);
	render.fillRectangle(white, margin, barY, barW, barH);
	if (fill > 0) render.fillRectangle(fillColor, margin, barY, fill, barH);
}

/**
 * 12 hour ticks (stroke 2); 弓 at 9, 道 at 3 (Noto Sans JP via manifest). Hands: green/red; stroke 2.
 */
function drawAnalogClock(date, rw, rh) {
	const cx = Math.floor(rw / 2);
	const cy = Math.floor(rh / 2);
	const r = Math.max(8, Math.floor(Math.min(rw, rh) / 2) - 4);

	for (let t = 0; t < 12; t++) {
		const ang = (t / 12) * 2 * Math.PI;
		const x0 = cx + Math.floor((r - 6) * Math.sin(ang));
		const y0 = cy - Math.floor((r - 6) * Math.cos(ang));
		const x1 = cx + Math.floor(r * Math.sin(ang));
		const y1 = cy - Math.floor(r * Math.cos(ang));
		render.drawLine(x0, y0, x1, y1, black, 2);
	}

	const labelDist = Math.max(18, Math.floor(r * 0.62)) + 20;
	const yLabel = cy - Math.floor(dialLabelFont.height / 2);
	const wDo = render.getTextWidth(KANJI_DO, dialLabelFont);
	const wKyu = render.getTextWidth(KANJI_KYU, dialLabelFont);
	render.drawText(KANJI_DO, dialLabelFont, black, cx + labelDist - Math.floor(wDo / 2), yLabel);
	render.drawText(KANJI_KYU, dialLabelFont, black, cx - labelDist - Math.floor(wKyu / 2), yLabel);

	const s = date.getSeconds();
	const m = date.getMinutes();
	const h = date.getHours() % 12;

	const secAngle = (s / 60) * 2 * Math.PI;
	const minAngle = ((m + s / 60) / 60) * 2 * Math.PI;
	const hourAngle = ((h + m / 60 + s / 3600) / 12) * 2 * Math.PI;

	function drawArrowHand(angle, len, headLen, headW, color, stroke) {
		const dx = Math.sin(angle);
		const dy = -Math.cos(angle);
		const px = Math.cos(angle);
		const py = Math.sin(angle);

		const tipX = cx + Math.floor(len * dx);
		const tipY = cy + Math.floor(len * dy);
		const neckX = tipX - Math.floor(headLen * dx);
		const neckY = tipY - Math.floor(headLen * dy);

		render.drawLine(cx, cy, neckX, neckY, color, stroke);

		const lx = neckX + Math.floor(headW * px);
		const ly = neckY + Math.floor(headW * py);
		const rx = neckX - Math.floor(headW * px);
		const ry = neckY - Math.floor(headW * py);
		render.drawLine(tipX, tipY, lx, ly, color, stroke);
		render.drawLine(tipX, tipY, rx, ry, color, stroke);
	}

	const hr = Math.max(10, Math.floor(r * 0.5));
	const mr = Math.max(14, Math.floor(r * 0.76));
	const sr = Math.max(18, Math.floor(r * 0.92));

	drawArrowHand(hourAngle, hr, Math.max(10, Math.floor(r * 0.09)), Math.max(7, Math.floor(r * 0.05)), green, 2);
	drawArrowHand(minAngle, mr, Math.max(9, Math.floor(r * 0.07)), Math.max(6, Math.floor(r * 0.04)), green, 2);
	drawArrowHand(secAngle, sr, Math.max(8, Math.floor(r * 0.06)), Math.max(5, Math.floor(r * 0.035)), red, 2);
}

function draw(e) {
	const date = e?.date ?? new Date();
	const rw = render.width;
	const rh = render.height;
	if (rw <= 0 || rh <= 0) {
		return;
	}

	const bs = batteryReader.sample();
	if (bs) { batteryPercent = bs.percent; batteryCharging = bs.charging; }

	const idx = frameIndexForTime(date);
	const bitmap = getKyudoBitmap(idx);
	if (!bitmap) {
		render.begin();
		render.fillRectangle(white, 0, 0, rw, rh);
		render.end();
		return;
	}

	render.begin();

	const bx = Math.floor((rw - bitmap.width) / 2);
	const by = Math.floor((rh - bitmap.height) / 2);
	render.drawBitmap(bitmap, bx, by);

	drawBatteryBar(rw);
	drawAnalogClock(date, rw, rh);

	render.end();
}


watch.addEventListener("secondchange", draw);
watch.addEventListener("resize", draw);

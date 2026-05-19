import {
    loadTextToSpeech,
    loadVoiceStyle,
    writeWavFile
} from './helper.js';
import { openZipBundle } from './zipBundle.js';

const MODELS_ZIP_URL = 'https://github.com/alazi900-coder/supertonic-ar/releases/download/models-v1/supertonic-ar-models.zip';

// Configuration
// When this app is deployed (no local /assets folder), fetch model weights and
// voice styles from raw.githubusercontent.com — GitHub serves raw files with
// `Access-Control-Allow-Origin: *` so cross-origin loading works.
const MODEL_HOSTED = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
const RAW_BASE = 'https://raw.githubusercontent.com/alazi900-coder/supertonic-ar/models';
const ONNX_BASE = MODEL_HOSTED ? `${RAW_BASE}/onnx` : 'assets/onnx';
const VOICE_STYLES_BASE = MODEL_HOSTED ? `${RAW_BASE}/voice_styles` : 'assets/voice_styles';

// vector_estimator.onnx is ~245 MB so it is sharded into chunks of <100 MB to
// fit within GitHub's per-file size limit. When MODEL_HOSTED, we fetch all
// shards and concatenate them in the browser before passing to ONNX Runtime.
const VECTOR_ESTIMATOR_CHUNKS = [
    `${RAW_BASE}/onnx/vector_estimator.part.0`,
    `${RAW_BASE}/onnx/vector_estimator.part.1`,
    `${RAW_BASE}/onnx/vector_estimator.part.2`,
    `${RAW_BASE}/onnx/vector_estimator.part.3`,
];

// Lazy bundle backed by an imported ZIP file. Built by `openZipBundle()` and
// exposes `.blob(key)` for each canonical entry (e.g. `onnx/tts.json`,
// `voice_styles/M1.json`). When the bundle is set, model loading bypasses
// the network and pulls bytes directly from disk-backed Blob slices — this
// keeps peak memory low enough to work reliably on Android.
let modelBundle = null;

async function modelOverrides() {
    if (modelBundle) {
        const [tts, unicode_indexer, duration_predictor, text_encoder, vocoder, vector_estimator] =
            await Promise.all([
                modelBundle.blob('onnx/tts.json'),
                modelBundle.blob('onnx/unicode_indexer.json'),
                modelBundle.blob('onnx/duration_predictor.onnx'),
                modelBundle.blob('onnx/text_encoder.onnx'),
                modelBundle.blob('onnx/vocoder.onnx'),
                modelBundle.blob('onnx/vector_estimator.onnx'),
            ]);
        return { tts, unicode_indexer, duration_predictor, text_encoder, vocoder, vector_estimator };
    }
    if (!MODEL_HOSTED) return {};
    return {
        tts: `${ONNX_BASE}/tts.json`,
        unicode_indexer: `${ONNX_BASE}/unicode_indexer.json`,
        duration_predictor: `${ONNX_BASE}/duration_predictor.onnx`,
        text_encoder: `${ONNX_BASE}/text_encoder.onnx`,
        vocoder: `${ONNX_BASE}/vocoder.onnx`,
        vector_estimator: { chunks: VECTOR_ESTIMATOR_CHUNKS },
    };
}

async function voiceStyleSource(localPath) {
    const filename = getFilenameFromPath(localPath);
    if (modelBundle && modelBundle.has(`voice_styles/${filename}`)) {
        return await modelBundle.blob(`voice_styles/${filename}`);
    }
    if (!MODEL_HOSTED) return localPath;
    return `${VOICE_STYLES_BASE}/${filename}`;
}

const DEFAULT_VOICE_STYLE_PATH = 'assets/voice_styles/M1.json';

// Helper function to extract filename from path
function getFilenameFromPath(path) {
    return String(path).split('/').pop();
}

// Format a number using Arabic-Indic digits for nicer presentation.
function toArabicDigits(value) {
    const map = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
    return String(value).replace(/[0-9]/g, (d) => map[d]);
}

// Global state
let textToSpeech = null;
let cfgs = null;

// Pre-computed style
let currentStyle = null;
let currentStylePath = DEFAULT_VOICE_STYLE_PATH;

// UI Elements
const textInput = document.getElementById('text');
const voiceStyleSelect = document.getElementById('voiceStyleSelect');
const voiceStyleInfo = document.getElementById('voiceStyleInfo');
const langSelect = document.getElementById('langSelect');
const totalStepInput = document.getElementById('totalStep');
const speedInput = document.getElementById('speed');
const generateBtn = document.getElementById('generateBtn');
const statusBox = document.getElementById('statusBox');
const statusText = document.getElementById('statusText');
const backendBadge = document.getElementById('backendBadge');
const resultsContainer = document.getElementById('results');
const errorBox = document.getElementById('error');
const progressWrap = document.getElementById('progressWrap');
const progressFill = document.getElementById('progressFill');
const progressMeta = document.getElementById('progressMeta');
const importPanel = document.getElementById('importPanel');
const importZipBtn = document.getElementById('importZipBtn');
const importZipInput = document.getElementById('importZipInput');
const startNetworkBtn = document.getElementById('startNetworkBtn');
const downloadZipLink = document.getElementById('downloadZipLink');

const MODEL_NAME_AR = {
    'Duration Predictor': 'توقع مدة الصوت (Duration Predictor)',
    'Text Encoder': 'ترميز النص (Text Encoder)',
    'Vector Estimator': 'تقدير المتجهات (Vector Estimator)',
    'Vocoder': 'المُوليّد الصوتي (Vocoder)',
};

function formatBytes(bytes) {
    if (!bytes || bytes <= 0) return '0';
    const mb = bytes / (1024 * 1024);
    if (mb >= 100) return `${toArabicDigits(Math.round(mb))} م.ب`;
    return `${toArabicDigits(mb.toFixed(1))} م.ب`;
}

function renderProgress(evt) {
    progressWrap.hidden = false;
    const total = evt.bytesTotal || 0;
    const recv = evt.bytesReceived || 0;
    const pct = total > 0 ? Math.min(100, (recv / total) * 100) : 0;
    progressFill.style.width = `${pct.toFixed(1)}%`;
    const arName = MODEL_NAME_AR[evt.modelName] || evt.modelName;
    const idx = toArabicDigits(evt.modelIndex);
    const cnt = toArabicDigits(evt.modelCount);
    const sizeText = total > 0
        ? `${formatBytes(recv)} / ${formatBytes(total)} (${toArabicDigits(pct.toFixed(0))}٪)`
        : `${formatBytes(recv)}`;
    progressMeta.innerHTML =
        `<span><strong>النموذج ${idx}/${cnt}:</strong> ${arName}</span>` +
        `<span>${sizeText}</span>`;
}

function hideProgress() {
    progressWrap.hidden = true;
    progressFill.style.width = '0%';
    progressMeta.textContent = '';
}

function showStatus(message, type = 'info') {
    statusText.innerHTML = message;
    statusBox.className = 'status-box';
    if (type === 'success') {
        statusBox.classList.add('success');
    } else if (type === 'error') {
        statusBox.classList.add('error');
    }
}

function showError(message) {
    errorBox.textContent = message;
    errorBox.classList.add('active');
}

function hideError() {
    errorBox.classList.remove('active');
}

function showBackendBadge() {
    backendBadge.classList.add('visible');
}

// Load voice style from JSON
async function loadStyleFromJSON(stylePath) {
    try {
        const source = await voiceStyleSource(stylePath);
        const style = await loadVoiceStyle([source], true);
        return style;
    } catch (error) {
        console.error('Error loading voice style:', error);
        throw error;
    }
}

function validateBundle(bundle) {
    const required = [
        'onnx/tts.json',
        'onnx/unicode_indexer.json',
        'onnx/duration_predictor.onnx',
        'onnx/text_encoder.onnx',
        'onnx/vector_estimator.onnx',
        'onnx/vocoder.onnx',
        'voice_styles/M1.json',
    ];
    const missing = required.filter((k) => !bundle.has(k));
    if (missing.length > 0) {
        throw new Error(`الملف لا يحتوي على: ${missing.join(', ')}`);
    }
}

async function probeWebGPU() {
    if (typeof navigator === 'undefined' || !navigator.gpu) return false;
    try {
        const adapter = await Promise.race([
            navigator.gpu.requestAdapter().catch(() => null),
            new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (!adapter) return false;
        const device = await Promise.race([
            adapter.requestDevice().catch(() => null),
            new Promise((resolve) => setTimeout(() => resolve(null), 2500)),
        ]);
        if (!device) return false;
        try { device.destroy(); } catch (_) { /* ignore */ }
        return true;
    } catch (_) {
        return false;
    }
}

function hideImportPanel() {
    if (importPanel) importPanel.hidden = true;
}

function showImportPanel() {
    if (importPanel) importPanel.hidden = false;
}

// Load models on page load
async function initializeModels() {
    try {
        hideImportPanel();
        showStatus(modelBundle
            ? 'ℹ️ <strong>جارٍ فكّ ملفات النماذج المستوردة…</strong>'
            : 'ℹ️ <strong>جارٍ تحميل الإعدادات…</strong>');

        const basePath = ONNX_BASE;
        const overrides = await modelOverrides();

        // Probe WebGPU support — only attempt the WebGPU EP if the browser
        // actually advertises a working adapter. On many mobile browsers
        // (Kiwi, Samsung Internet, …) `navigator.gpu` is defined but the
        // first call to `InferenceSession.create({executionProviders:['webgpu']})`
        // hangs while trying to acquire a GPU device. To keep mobile users
        // from seeing the loader freeze on the first model, we fall straight
        // to WASM unless we can verify a real adapter.
        let executionProvider = 'wasm';
        const onProgress = (evt) => {
            if (evt.phase === 'start') {
                showStatus(`ℹ️ <strong>جارٍ تحميل النموذج…</strong>`);
            } else if (evt.phase === 'done') {
                showStatus(`ℹ️ <strong>تمّ تحميل ${MODEL_NAME_AR[evt.modelName] || evt.modelName}</strong>`);
            }
            renderProgress(evt);
        };

        const webgpuAvailable = await probeWebGPU();
        if (webgpuAvailable) {
            try {
                const result = await loadTextToSpeech(basePath, {
                    executionProviders: ['webgpu'],
                    graphOptimizationLevel: 'all'
                }, onProgress, overrides);

                textToSpeech = result.textToSpeech;
                cfgs = result.cfgs;

                executionProvider = 'webgpu';
                backendBadge.textContent = 'WebGPU';
                backendBadge.style.background = '#4caf50';
            } catch (webgpuError) {
                console.log('WebGPU session create failed, falling back to WebAssembly', webgpuError);
                textToSpeech = null;
                cfgs = null;
            }
        }
        if (!textToSpeech) {
            const result = await loadTextToSpeech(basePath, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            }, onProgress, overrides);

            textToSpeech = result.textToSpeech;
            cfgs = result.cfgs;
        }

        showStatus('ℹ️ <strong>جارٍ تحميل نمط الصوت الافتراضي…</strong>');

        // Load default voice style
        currentStyle = await loadStyleFromJSON(currentStylePath);
        voiceStyleInfo.textContent = `${getFilenameFromPath(currentStylePath)} (افتراضي)`;

        showStatus(`✅ <strong>تم تحميل النماذج!</strong> يعمل التطبيق على ${executionProvider.toUpperCase()}. يمكنك الآن توليد الصوت.`, 'success');
        hideProgress();
        showBackendBadge();

        generateBtn.disabled = false;

    } catch (error) {
        console.error('Error loading models:', error);
        showStatus(`❌ <strong>تعذّر تحميل النماذج:</strong> ${error.message}`, 'error');
        showImportPanel();
    }
}

async function handleZipImport(file) {
    try {
        hideImportPanel();
        hideError();
        showStatus(`ℹ️ <strong>جارٍ قراءة فهرس ملف النماذج…</strong> ${file.name} (${formatBytes(file.size)})`);
        progressWrap.hidden = false;
        progressFill.style.width = '20%';
        progressMeta.innerHTML = `<span><strong>قراءة فهرس ZIP…</strong></span><span>${formatBytes(file.size)}</span>`;

        // Open the archive as a *lazy* bundle — only the ZIP central directory
        // (~1 kB at the end of the file) is read here. Individual entries are
        // pulled in on demand when the models are actually loaded.
        const bundle = await openZipBundle(file);
        validateBundle(bundle);
        modelBundle = bundle;

        progressFill.style.width = '40%';
        progressMeta.innerHTML = `<span><strong>تم العثور على ${toArabicDigits(bundle.size)} ملفاً…</strong></span><span>${formatBytes(file.size)}</span>`;

        await initializeModels();
    } catch (error) {
        console.error('ZIP import failed:', error);
        hideProgress();
        showStatus(`❌ <strong>فشل استيراد الملف:</strong> ${error.message}`, 'error');
        showError(`فشل استيراد الملف: ${error.message}`);
        showImportPanel();
    }
}

// Handle voice style selection
voiceStyleSelect.addEventListener('change', async (e) => {
    const selectedValue = e.target.value;

    if (!selectedValue) return;

    try {
        generateBtn.disabled = true;
        showStatus(`ℹ️ <strong>جارٍ تحميل نمط الصوت…</strong>`, 'info');

        currentStylePath = selectedValue;
        currentStyle = await loadStyleFromJSON(currentStylePath);
        voiceStyleInfo.textContent = getFilenameFromPath(currentStylePath);

        showStatus(`✅ <strong>تم تحميل نمط الصوت:</strong> ${getFilenameFromPath(currentStylePath)}`, 'success');
        generateBtn.disabled = false;
    } catch (error) {
        showError(`تعذّر تحميل نمط الصوت: ${error.message}`);

        // Restore default style
        currentStylePath = DEFAULT_VOICE_STYLE_PATH;
        voiceStyleSelect.value = currentStylePath;
        try {
            currentStyle = await loadStyleFromJSON(currentStylePath);
            voiceStyleInfo.textContent = `${getFilenameFromPath(currentStylePath)} (افتراضي)`;
        } catch (styleError) {
            console.error('Error restoring default style:', styleError);
        }

        generateBtn.disabled = false;
    }
});

// Main synthesis function
async function generateSpeech() {
    const text = textInput.value.trim();
    if (!text) {
        showError('فضلاً أدخل نصاً لتوليده.');
        return;
    }

    if (!textToSpeech || !cfgs) {
        showError('النماذج ما زالت قيد التحميل، يرجى الانتظار.');
        return;
    }

    if (!currentStyle) {
        showError('نمط الصوت غير جاهز بعد، يرجى الانتظار.');
        return;
    }

    const startTime = Date.now();

    try {
        generateBtn.disabled = true;
        hideError();

        // Clear results and show placeholder
        resultsContainer.innerHTML = `
            <div class="results-placeholder generating">
                <div class="results-placeholder-icon">⏳</div>
                <p>جارٍ توليد الصوت…</p>
            </div>
        `;

        const totalStep = parseInt(totalStepInput.value);
        const speed = parseFloat(speedInput.value);
        const lang = langSelect.value;

        showStatus('ℹ️ <strong>جارٍ توليد الصوت من النص…</strong>');
        const tic = Date.now();

        const { wav, duration } = await textToSpeech.call(
            text,
            lang,
            currentStyle,
            totalStep,
            speed,
            0.3,
            (step, total) => {
                showStatus(`ℹ️ <strong>إزالة الضوضاء (${toArabicDigits(step)}/${toArabicDigits(total)})…</strong>`);
            }
        );

        const toc = Date.now();
        console.log(`Text-to-speech synthesis: ${((toc - tic) / 1000).toFixed(2)}s`);

        showStatus('ℹ️ <strong>جارٍ إنشاء ملف الصوت…</strong>');
        const wavLen = Math.floor(textToSpeech.sampleRate * duration[0]);
        const wavOut = wav.slice(0, wavLen);

        // Create WAV file
        const wavBuffer = writeWavFile(wavOut, textToSpeech.sampleRate);
        const blob = new Blob([wavBuffer], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);

        // Calculate total time and audio duration
        const endTime = Date.now();
        const totalTimeSec = ((endTime - startTime) / 1000).toFixed(2);
        const audioDurationSec = duration[0].toFixed(2);

        // Display result with full text
        const escapedText = text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');

        resultsContainer.innerHTML = `
            <div class="result-item">
                <div class="result-text-container">
                    <div class="result-text-label">النص المُدخل</div>
                    <div class="result-text">${escapedText}</div>
                </div>
                <div class="result-info">
                    <div class="info-item">
                        <span>📊 طول الصوت</span>
                        <strong>${toArabicDigits(audioDurationSec)} ث</strong>
                    </div>
                    <div class="info-item">
                        <span>⏱️ زمن التوليد</span>
                        <strong>${toArabicDigits(totalTimeSec)} ث</strong>
                    </div>
                </div>
                <div class="result-player">
                    <audio controls>
                        <source src="${url}" type="audio/wav">
                    </audio>
                </div>
                <div class="result-actions">
                    <button onclick="downloadAudio('${url}', 'supertonic_arabic.wav')">
                        <span>⬇️</span>
                        <span>تنزيل ملف WAV</span>
                    </button>
                </div>
            </div>
        `;

        showStatus('✅ <strong>اكتمل التوليد بنجاح!</strong>', 'success');

    } catch (error) {
        console.error('Error during synthesis:', error);
        showStatus(`❌ <strong>خطأ أثناء التوليد:</strong> ${error.message}`, 'error');
        showError(`خطأ أثناء التوليد: ${error.message}`);

        // Restore placeholder
        resultsContainer.innerHTML = `
            <div class="results-placeholder">
                <div class="results-placeholder-icon">🎤</div>
                <p>سيظهر الصوت المُولَّد هنا</p>
            </div>
        `;
    } finally {
        generateBtn.disabled = false;
    }
}

// Download handler (make it global so it can be called from onclick)
window.downloadAudio = function(url, filename) {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
};

// Attach generate function to button
generateBtn.addEventListener('click', generateSpeech);

// Wire ZIP import button
if (importZipBtn && importZipInput) {
    importZipBtn.addEventListener('click', () => importZipInput.click());
    importZipInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        handleZipImport(file);
        e.target.value = '';
    });
}

// Wire "download from internet" button
if (startNetworkBtn) {
    startNetworkBtn.addEventListener('click', () => {
        modelBundle = null;
        initializeModels();
    });
}

if (downloadZipLink) {
    downloadZipLink.href = MODELS_ZIP_URL;
}

// Register the PWA service worker so the page is installable on Android.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('sw.js')
            .catch((err) => console.warn('Service worker registration failed:', err));
    });
}

// On load, show the choose-how-to-load panel rather than auto-fetching ~382MB.
window.addEventListener('load', () => {
    generateBtn.disabled = true;
    showImportPanel();
    showStatus('ℹ️ <strong>اختر طريقة تحميل النماذج بالأسفل.</strong>');
});

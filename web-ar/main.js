import {
    loadTextToSpeech,
    loadVoiceStyle,
    writeWavFile
} from './helper.js';

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

function modelOverrides() {
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

function voiceStyleUrl(localPath) {
    if (!MODEL_HOSTED) return localPath;
    return `${VOICE_STYLES_BASE}/${getFilenameFromPath(localPath)}`;
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
        const url = voiceStyleUrl(stylePath);
        const style = await loadVoiceStyle([url], true);
        return style;
    } catch (error) {
        console.error('Error loading voice style:', error);
        throw error;
    }
}

// Load models on page load
async function initializeModels() {
    try {
        showStatus('ℹ️ <strong>جارٍ تحميل الإعدادات…</strong>');

        const basePath = ONNX_BASE;
        const overrides = modelOverrides();

        // Try WebGPU first, fallback to WASM
        let executionProvider = 'wasm';
        try {
            const result = await loadTextToSpeech(basePath, {
                executionProviders: ['webgpu'],
                graphOptimizationLevel: 'all'
            }, (modelName, current, total) => {
                showStatus(`ℹ️ <strong>تحميل نماذج ONNX (${toArabicDigits(current)}/${toArabicDigits(total)}):</strong> ${modelName}…`);
            }, overrides);

            textToSpeech = result.textToSpeech;
            cfgs = result.cfgs;

            executionProvider = 'webgpu';
            backendBadge.textContent = 'WebGPU';
            backendBadge.style.background = '#4caf50';
        } catch (webgpuError) {
            console.log('WebGPU not available, falling back to WebAssembly');

            const result = await loadTextToSpeech(basePath, {
                executionProviders: ['wasm'],
                graphOptimizationLevel: 'all'
            }, (modelName, current, total) => {
                showStatus(`ℹ️ <strong>تحميل نماذج ONNX (${toArabicDigits(current)}/${toArabicDigits(total)}):</strong> ${modelName}…`);
            }, overrides);

            textToSpeech = result.textToSpeech;
            cfgs = result.cfgs;
        }

        showStatus('ℹ️ <strong>جارٍ تحميل نمط الصوت الافتراضي…</strong>');

        // Load default voice style
        currentStyle = await loadStyleFromJSON(currentStylePath);
        voiceStyleInfo.textContent = `${getFilenameFromPath(currentStylePath)} (افتراضي)`;

        showStatus(`✅ <strong>تم تحميل النماذج!</strong> يعمل التطبيق على ${executionProvider.toUpperCase()}. يمكنك الآن توليد الصوت.`, 'success');
        showBackendBadge();

        generateBtn.disabled = false;

    } catch (error) {
        console.error('Error loading models:', error);
        showStatus(`❌ <strong>تعذّر تحميل النماذج:</strong> ${error.message}`, 'error');
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

// Register the PWA service worker so the page is installable on Android.
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker
            .register('sw.js')
            .catch((err) => console.warn('Service worker registration failed:', err));
    });
}

// Initialize on load
window.addEventListener('load', async () => {
    generateBtn.disabled = true;
    await initializeModels();
});

/*
 * zipBundle.js
 * ============
 *
 * Memory-friendly ZIP reader for the imported `supertonic-ar-models.zip`.
 *
 * Background
 * ----------
 * On Android Chrome the JS heap is much smaller than on desktop. If we eagerly
 * decompress the ~400 MB ZIP into a Map<name, Uint8Array> we briefly hold
 *   - the original 400 MB ZIP buffer
 *   - a 380 MB worth of extracted entries
 *   - 300-500 MB of ONNX Runtime working memory
 * which exceeds the per-tab heap and causes silent allocation failures /
 * partially-zeroed buffers — observed as "the audio is just noise" on
 * Android phones, while the desktop run produces correct speech for the same
 * code path.
 *
 * Fix
 * ---
 * Parse the ZIP central directory manually (the file is fully STORED — no
 * deflate) and expose each entry as a lazy `Blob.slice()` view into the
 * underlying File. No bytes are loaded into JS memory until the consumer
 * explicitly reads a single entry. Peak memory while loading models becomes
 * "one model at a time" instead of "all models simultaneously".
 *
 * For robustness we also support DEFLATE-compressed entries via the native
 * `DecompressionStream('deflate-raw')` API. Modern Android/desktop Chrome,
 * Firefox and Safari all support it.
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOCATOR = 0x07064b50;
const SIG_CDIR = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

function le16(view, offset) {
    return view.getUint16(offset, true);
}
function le32(view, offset) {
    return view.getUint32(offset, true);
}
function le64(view, offset) {
    const lo = view.getUint32(offset, true);
    const hi = view.getUint32(offset + 4, true);
    return hi * 0x1_0000_0000 + lo;
}

async function readSlice(file, start, end) {
    const buf = await file.slice(start, end).arrayBuffer();
    return new DataView(buf);
}

async function findEocd(file) {
    const size = file.size;
    // EOCD record is at most 22 + 65535 bytes from end of file.
    const tailSize = Math.min(size, 65557);
    const tailStart = size - tailSize;
    const tail = await readSlice(file, tailStart, size);
    for (let i = tail.byteLength - 22; i >= 0; i--) {
        if (le32(tail, i) === SIG_EOCD) {
            return { tail, eocdOffsetInTail: i, tailStart };
        }
    }
    throw new Error('ZIP غير صالح: لم يتم العثور على سجل EOCD.');
}

async function readCentralDirectory(file) {
    const { tail, eocdOffsetInTail, tailStart } = await findEocd(file);

    let totalEntries = le16(tail, eocdOffsetInTail + 10);
    let cdSize = le32(tail, eocdOffsetInTail + 12);
    let cdOffset = le32(tail, eocdOffsetInTail + 16);

    // ZIP64 sentinel — switch to 64-bit EOCD if any field is 0xFFFFFFFF / 0xFFFF.
    if (totalEntries === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
        // Look for ZIP64 locator (20 bytes long) just before the EOCD.
        const locatorStart = eocdOffsetInTail - 20;
        if (locatorStart >= 0 && le32(tail, locatorStart) === SIG_EOCD64_LOCATOR) {
            const eocd64Off = le64(tail, locatorStart + 8);
            const eocd64 = await readSlice(file, eocd64Off, eocd64Off + 56);
            if (le32(eocd64, 0) !== SIG_EOCD64) {
                throw new Error('ZIP64 EOCD signature mismatch');
            }
            totalEntries = le64(eocd64, 32);
            cdSize = le64(eocd64, 40);
            cdOffset = le64(eocd64, 48);
        }
    }

    const cdView = await readSlice(file, cdOffset, cdOffset + cdSize);
    const decoder = new TextDecoder('utf-8');
    const entries = [];
    let p = 0;
    for (let i = 0; i < totalEntries; i++) {
        if (le32(cdView, p) !== SIG_CDIR) {
            throw new Error(`ZIP غير صالح عند الإدخال ${i}`);
        }
        const method = le16(cdView, p + 10);
        let compressedSize = le32(cdView, p + 20);
        let uncompressedSize = le32(cdView, p + 24);
        const nameLen = le16(cdView, p + 28);
        const extraLen = le16(cdView, p + 30);
        const commentLen = le16(cdView, p + 32);
        let localHeaderOffset = le32(cdView, p + 42);
        const nameBytes = new Uint8Array(cdView.buffer, cdView.byteOffset + p + 46, nameLen);
        const name = decoder.decode(nameBytes);

        // ZIP64 extra block — parse if any field was a sentinel.
        if (compressedSize === 0xFFFFFFFF || uncompressedSize === 0xFFFFFFFF || localHeaderOffset === 0xFFFFFFFF) {
            const extraView = new DataView(cdView.buffer, cdView.byteOffset + p + 46 + nameLen, extraLen);
            let ep = 0;
            while (ep + 4 <= extraView.byteLength) {
                const tag = extraView.getUint16(ep, true);
                const blockSize = extraView.getUint16(ep + 2, true);
                if (tag === 0x0001) {
                    let inner = ep + 4;
                    if (uncompressedSize === 0xFFFFFFFF) { uncompressedSize = le64(extraView, inner); inner += 8; }
                    if (compressedSize === 0xFFFFFFFF) { compressedSize = le64(extraView, inner); inner += 8; }
                    if (localHeaderOffset === 0xFFFFFFFF) { localHeaderOffset = le64(extraView, inner); inner += 8; }
                    break;
                }
                ep += 4 + blockSize;
            }
        }

        entries.push({
            name,
            method,
            compressedSize,
            uncompressedSize,
            localHeaderOffset,
        });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

async function localDataOffset(file, entry) {
    // Local file header layout: 30 bytes header + name + extra. The CD's
    // (nameLen, extraLen) can differ from the local copy, so we have to read
    // the local header to know where the data actually starts.
    const headerEnd = entry.localHeaderOffset + 30;
    const head = await readSlice(file, entry.localHeaderOffset, headerEnd);
    if (le32(head, 0) !== SIG_LOCAL) {
        throw new Error(`Local header signature mismatch for ${entry.name}`);
    }
    const nameLen = le16(head, 26);
    const extraLen = le16(head, 28);
    return entry.localHeaderOffset + 30 + nameLen + extraLen;
}

async function entryBlob(file, entry) {
    const dataStart = await localDataOffset(file, entry);
    const dataEnd = dataStart + entry.compressedSize;
    const raw = file.slice(dataStart, dataEnd);
    if (entry.method === 0) {
        return raw; // STORED — Blob slice is the actual entry data.
    }
    if (entry.method === 8) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('متصفّحك لا يدعم فكّ ضغط Deflate. يُفضّل استخدام Chrome حديث.');
        }
        // Convert deflate-raw stream to Blob.
        const stream = raw.stream().pipeThrough(new DecompressionStream('deflate-raw'));
        return new Response(stream).blob();
    }
    throw new Error(`طريقة ضغط غير مدعومة (${entry.method}) للملف ${entry.name}`);
}

/**
 * Open a ZIP file and return a lazy bundle view. Reading actual bytes for an
 * entry happens only inside `.bytes(key)` / `.arrayBuffer(key)` / `.json(key)`.
 */
export async function openZipBundle(file) {
    const entries = await readCentralDirectory(file);
    const byKey = new Map();
    for (const e of entries) {
        if (!e.name || e.name.endsWith('/')) continue;
        const norm = e.name.replace(/\\/g, '/');
        const base = norm.split('/').pop();
        if (norm.includes('voice_styles/') && base.endsWith('.json')) {
            byKey.set(`voice_styles/${base}`, e);
        } else if (norm.includes('onnx/') || /(\.onnx|tts\.json|unicode_indexer\.json)$/.test(base)) {
            byKey.set(`onnx/${base}`, e);
        }
    }
    return {
        size: byKey.size,
        keys: () => Array.from(byKey.keys()),
        has: (key) => byKey.has(key),
        entry: (key) => byKey.get(key) || null,
        async blob(key) {
            const e = byKey.get(key);
            if (!e) throw new Error(`المفتاح غير موجود: ${key}`);
            return entryBlob(file, e);
        },
        async arrayBuffer(key) {
            const b = await this.blob(key);
            return await b.arrayBuffer();
        },
        async bytes(key) {
            const ab = await this.arrayBuffer(key);
            return new Uint8Array(ab);
        },
        async json(key) {
            const b = await this.blob(key);
            const text = await b.text();
            return JSON.parse(text);
        },
    };
}

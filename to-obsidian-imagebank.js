#!/Users/naoaki/.nvm/versions/node/v20.19.3/bin/node

// @raycast.schemaVersion 1
// @raycast.title ImageBank → Obsidian
// @raycast.mode compact
// @raycast.packageName Med
// @raycast.icon 🖼️

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ────────────────────────────────────────────────────────────────

const HOME = os.homedir();
const CONFIG_FILE = path.join(HOME, '.config', 'spokenly-obsidian', 'config.json');

let config = {};
try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch {}

const GEMINI_API_KEY = config.geminiApiKey || process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = config.geminiModel || 'gemini-3.1-flash-lite';

const MED_DIR = path.join(HOME, 'Library/Mobile Documents/iCloud~md~obsidian/Documents/Med');
const IMAGEBANK_DIR = path.join(MED_DIR, 'ImageBank');
const ATTACHMENTS_DIR = path.join(MED_DIR, 'attachments');
const TEMPLATE_PATH = path.join(IMAGEBANK_DIR, '0.template', 'template_imagebank.md');

// ─── 日付ユーティリティ ─────────────────────────────────────────────────────

function now() {
  return new Date();
}

function toJSTStr(date) {
  const jst = new Date(date.getTime() + 9 * 3600 * 1000);
  const pad = n => String(n).padStart(2, '0');
  return `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())}`;
}

function toFileTag(date) {
  return toJSTStr(date).replace(' ', '_').replace(':', '-');
}

// ─── クリップボードから画像を保存 ───────────────────────────────────────────

function saveClipboardImage(destPath) {
  const script = `
try
  set theData to (the clipboard as «class PNGf»)
  set theFile to open for access POSIX file "${destPath}" with write permission
  write theData to theFile
  close access theFile
  return "ok"
on error e
  return "error: " & e
end try`;

  const tmpScript = `/tmp/clip_img_${Date.now()}.applescript`;
  fs.writeFileSync(tmpScript, script, 'utf8');

  let result;
  try {
    result = execSync(`osascript '${tmpScript}'`, { timeout: 10000 }).toString().trim();
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }

  if (!result.startsWith('ok')) {
    throw new Error(`クリップボードに画像がありません (${result})`);
  }
}

// ─── AppleScript でテキスト入力 ─────────────────────────────────────────────

function inputDialog(prompt, defaultAnswer = '') {
  const escaped = prompt.replace(/"/g, '\\"');
  const script = `set t to text returned of (display dialog "${escaped}" default answer "${defaultAnswer}" with title "ImageBank → Obsidian")
return t`;

  const tmpScript = `/tmp/imgbank_dialog_${Date.now()}.applescript`;
  fs.writeFileSync(tmpScript, script, 'utf8');

  let result;
  try {
    result = execSync(`osascript '${tmpScript}'`, { timeout: 30000 }).toString().trim();
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpScript); } catch {}
  }

  return result;
}

// ─── Gemini Vision API で OCR ───────────────────────────────────────────────

async function ocrWithGemini(imagePath) {
  const imageData = fs.readFileSync(imagePath).toString('base64');

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [
            {
              inline_data: {
                mime_type: 'image/png',
                data: imageData,
              },
            },
            {
              text: '画像内のテキストをすべて正確に抽出してください。テキストがない場合は空文字を返してください。前置きや説明は不要です。',
            },
          ],
        }],
        generationConfig: { temperature: 0 },
      }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API エラー: ${res.status} - ${err}`);
  }

  const data = await res.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}

// ─── ノート作成・保存 ────────────────────────────────────────────────────────

function buildNote(imageFileName, part, link, ocrText) {
  const template = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return template
    .replace(/^part:$/m, `part: ${part}`)
    .replace(/^link:$/m, `link: ${link}`)
    .replace('#### OCR', `![[${imageFileName}]]\n\n#### OCR`)
    .replace('<sup> content</sup>', `<sup>${ocrText}</sup>`);
}

function saveNote(content, title) {
  const fileName = `${title}.md`;
  const filePath = path.join(IMAGEBANK_DIR, fileName);

  if (fs.existsSync(filePath)) {
    throw new Error(`既に存在します: ${fileName}`);
  }

  fs.writeFileSync(filePath, content, 'utf8');
  return fileName;
}

// ─── メイン ─────────────────────────────────────────────────────────────────

async function main() {
  if (!GEMINI_API_KEY) {
    console.error('❌ GEMINI_API_KEY が未設定です。');
    process.exit(1);
  }

  const date = now();
  const fileTag = toFileTag(date);

  // 1. クリップボードから画像を一時保存して確認
  const tmpImagePath = `/tmp/imgbank_${fileTag}.png`;
  try {
    saveClipboardImage(tmpImagePath);
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }

  // 2. Titleを入力（ノート名）
  const title = inputDialog('Title（ノート名）を入力');
  if (title === null) {
    fs.unlinkSync(tmpImagePath);
    console.log('キャンセルされました。');
    return;
  }

  // 3. Partを入力
  const part = inputDialog('Part（解剖部位・カテゴリ）を入力');
  if (part === null) {
    fs.unlinkSync(tmpImagePath);
    console.log('キャンセルされました。');
    return;
  }

  // 4. Linkを入力（任意）
  const link = inputDialog('Link（なければ空のままOK）');
  if (link === null) {
    fs.unlinkSync(tmpImagePath);
    console.log('キャンセルされました。');
    return;
  }

  // 5. OCR
  console.log('⏳ OCR 処理中...');
  const ocrText = await ocrWithGemini(tmpImagePath);

  // 6. 画像をattachmentsへコピー
  const imageFileName = `ImageBank_${fileTag}.png`;
  const imageDest = path.join(ATTACHMENTS_DIR, imageFileName);
  fs.copyFileSync(tmpImagePath, imageDest);
  fs.unlinkSync(tmpImagePath);

  // 7. ノートを作成・保存
  const noteContent = buildNote(imageFileName, part, link, ocrText);
  const noteFileName = saveNote(noteContent, title);

  console.log(`✅ 保存完了: ${noteFileName}`);
}

main().catch(e => {
  console.error(`❌ エラー: ${e.message}`);
  process.exit(1);
});

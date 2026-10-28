# سنتر النور التعليمي — مولّد الاختبارات

موقع يعمل على الهاتف: شاشة افتتاحية متحركة باسم السنتر ووصف الأداة، ثم تفتح أداة توليد الاختبارات.
السمات (Themes) مشتركة بين الشاشة الافتتاحية والأداة وتُحفظ على الجهاز. يمكن تثبيته على الهاتف (Add to Home Screen).

## النشر (GitHub + Vercel)
1. أنشئ مستودعًا جديدًا على GitHub وارفع محتويات هذا المجلد (لا ترفع `.env.local` — مُستثنى تلقائيًا في `.gitignore`).
   ```bash
   git init && git add . && git commit -m "Al-Nour exam generator"
   git branch -M main
   git remote add origin https://github.com/<USER>/<REPO>.git
   git push -u origin main
   ```
2. في Vercel: **Add New → Project** → اختر المستودع (Framework: Next.js يُكتشف تلقائيًا).
3. قبل الضغط على Deploy: **Environment Variables** → أضف `GEMINI_API_KEY` = مفتاحك من https://aistudio.google.com/apikey
4. Deploy. افتح الرابط من الهاتف ← قائمة المتصفح ← "إضافة إلى الشاشة الرئيسية".

ملاحظات: الاختبارات المحفوظة تُخزَّن في متصفح كل جهاز (IndexedDB). الشاشة الافتتاحية تظهر مرة لكل جلسة، ويمكن تخطيها.

---

# CenterApp Exams

Upload a book (PDF) → choose pages / topic / question types / difficulty → the AI writes new questions → download several versions (A–F) and an answer key per version.

## Run
```bash
npm install
cp .env.example .env.local   # then put your GEMINI_API_KEY inside (free key: https://aistudio.google.com/apikey)
npm run dev                  # http://localhost:3000
```

## How it works
1. **Read**: pdf.js extracts the text of every page in the browser (the PDF is never uploaded).
2. **Chunk + retrieve**: the chosen page range is cut into chunks; with a topic they are ranked by BM25 keyword search (Arabic-aware), otherwise spread evenly.
3. **Generate (live)**: every 2 chunks go to `/api/generate`, which streams from Gemini. Each question is validated and shown on screen the moment it is written. Gemini's "thinking" is switched off to make it much faster.
4. **Limits**: when Google answers 429 the app reads *which* limit was hit. Per-minute -> countdown, then it resumes by itself. Per-day -> it stops, saves what it already wrote, and shows when the quota resets (midnight Pacific time). Google does not publish "requests left", so the counter on screen counts requests sent from this browser (approximate).
5. **Library (database)**: every exam is saved automatically in the browser's IndexedDB. Open it later to preview, delete bad questions, and print / download any version (A-F) or its answer key again. PDFs are rebuilt from the saved questions each time, so they always match.
6. **Versions**: same seed = same shuffle. Answers follow the shuffle, so each key is correct.

## Notes
- The library lives in *this browser on this computer*. It is not shared between devices, and clearing site data deletes it. For sharing between teachers/computers you need a server database (e.g. Supabase or SQLite).
- Scanned PDFs (images) have no text -> they need OCR first.
- Free tier: Google may use the text to improve its products and the free tier is meant for non-commercial use. Don't upload private books.
- If you deploy this publicly, protect `/api/generate` (login / rate limit).
- Change the model with `GEMINI_MODEL` in `.env.local`.
"# CenterExam" 

## Scanned PDFs (OCR)
Scanned pages are read locally in the browser with Tesseract (Arabic + English) — free, no API key, no quota.
`npm install` copies the OCR engine to `public/tesseract` (script: `scripts/setup-ocr.mjs`); language files live in `public/tessdata`.
Tips: scans of 200 DPI+ read best; expect ~2–6 s per page.

## Changes in this version
- **Exam PDF**: the page footer (center name + "صفحة n من N") was removed. The page margin is 0 (`@page{margin:0}`), so the browser adds no date / address / page-number lines. If a browser still shows them, untick **Headers and footers** in its print dialog.
- **Complete questions**: the AI prompt now forces every question to name its exact subject (e.g. الهالوجينات), forbids vague wording, and writes "علل" questions with the full statement. Cut-off questions are dropped. Text chunks overlap by 5 lines so a heading is never separated from its questions.
- **OCR (Arabic)**: pages are read at ~300 dpi (2400 px wide on a computer, 1700 on a phone), converted to grey with stretched contrast, and the engine is told the real dpi. The AI is also told the text came from OCR and to fix obvious missing letters.

## Changes in the latest version
- **No print dialog any more.** The "print" path (and its blank pages) was removed. Every download button now builds a real A4 PDF file straight away (computer: saved to Downloads; phone: a "Share / Save" sheet). Nothing is sent to the printer driver, so there are no blank or extra pages.
- **Different questions for every version.** The AI now writes (questions per version) x (number of versions) questions, and each version (A, B, C...) gets its own set. Example: 20 questions and 2 versions = 40 different questions. Later batches are told which questions already exist so they do not repeat them. Exams saved by older releases still open and print as before.
- **Question count per type.** Set how many multiple-choice, true/false and essay questions one version has (0 hides a type).
- **New exam sheet design.** Header with logo, title and version badge, student info fields, question/mark summary, dark section bars ("السؤال الأول..."), numbered question badges, lettered answer bubbles, tick boxes, dashed answer lines, page footer "n / N", and an end-of-exam line. The answer key has an answer-grid summary and highlights the correct choice.

## Subject picker (new)
- Before the tool opens, the teacher picks the subject (العلوم · العربي · الدراسات · الانجليزي · الرياضيات). The choice is remembered for the browser session; the chip in the header ("تغيير") reopens the picker.
- Subjects live in `lib/subjects.ts` (question types, default counts, sheet headings). **Science is fully configured**; the other four use the general types (MCQ / true-false / essay) until their own types are added — add a new entry there plus its rules in `app/api/generate/route.ts` (`subjectRules`).
- **Science question types:** اختيار من متعدد · صح وخطأ · علّل · أسئلة نظرية · مسائل علمية · معادلات (كتابة / وزن).
- **Smart file analysis** (`lib/detect.ts`, runs locally, no AI request): reads the cover/first pages to find the stage (ابتدائي / إعدادي / ثانوي) and grade, guesses the science branch, and checks whether the chosen pages contain chemical equations and numeric problems. The teacher can override the stage.
- **The tool adapts:** default counts follow the stage; types that do not fit (e.g. equations in primary, or pages with no equations) are greyed out with the reason and a "تفعيل" button to force them. The stage/branch are sent to the AI so wording, difficulty and rules match the level.
- **Quality checks (server):** a "علل" question must carry the full statement; a problem must have given numbers and a worked numeric answer; every equation answer is checked **atom by atom** (`lib/chem.ts`) and dropped if unbalanced.
- **PDF:** each type has its own section on the sheet; problems get a framed work area (المعطيات / الحل); the answer key shows the worked solution and the balanced equation.

## Latest changes (science tool)
- **New science question types:** اختر · صح وخطأ · علّل · وزن المعادلة · كتابة المعادلة · اكتب المصطلح · عرّف · قارن · أكمل. Every box starts at **0**; the teacher types the numbers (or presses "تطبيق الأعداد المقترحة").
- **File analysis waits for the page numbers.** Nothing is analysed (and no scanned page is OCR'd) until "من صفحة / إلى صفحة" are typed for each file. There is no stage/grade picker any more: the grade and branch are detected from the PDF, and the analysis decides which question types the chosen pages can support (`lib/analyze.ts`): definitions → عرّف / اكتب المصطلح, comparisons ("الفرق بين", "بينما", "يختلف") → قارن, cause words ("لأن", "بسبب", "لذلك") → علّل, chemical equations → وزن / كتابة. Unsupported types are greyed with the reason (and a "تفعيل" button to force them). Each box shows a suggested count.
- **Smarter writing:** the questions of each type are requested mostly from the text groups that contain suitable material, and the AI also receives the matching key sentences found in the text. The system prompt was rewritten (grounding, one idea per question, plausible MCQ distractors, believable false statements, self-check) and every new type has its own rules and server-side validation.
- **Compact exam PDF:** MCQ choices share one row (wrap only if too long), true/false sits on the question's own row, written answers get ONE line, "اكتب المصطلح" uses an inline blank, "أكمل" blanks are drawn inside the sentence, and spacing/margins were tightened.

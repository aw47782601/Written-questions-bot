# Medaad Book Q&A Bot

بوت تيليجرام: الأدمن بيرفع كتاب المنهج، وبعدين أي حد يبعت سؤال أو لحد 100 سؤال دفعة واحدة، والبوت بيدور في الكتاب (RAG) ويرجع الإجابات مع رقم الصفحة.

## إزاي بيشتغل

1. **الأدمن يبعت PDF نصي للبوت** → البوت يستخرج النص، يقسمه chunks، يعمل embeddings بـ Gemini، ويخزنهم في Supabase (`book_chunks`).
2. **أي حد يبعت سؤال (نص، أو ملف فيه أسئلة مرقمة)** → البوت:
   - يشوف لو السؤال ده اتسأل قبل كده (cache) → يرجع الإجابة المحفوظة فورًا
   - لو سؤال جديد: يعمل embedding له، يدور في `book_chunks` عن أقرب أجزاء، ويجمع الأسئلة الجديدة في batches (10 بالدفعة الواحدة افتراضيًا) ويبعتها لـ Gemini في نداء واحد لكل batch
   - يحفظ الإجابات الجديدة في الـ cache للمرة الجاية

## خطوات التجهيز

### 1. Supabase
- افتح مشروع Supabase (أو استخدم مشروعك الحالي)
- روح لـ SQL editor ونفذ محتوى `sql/schema.sql` بالكامل

### 2. Gemini API key
- اعمل key من [Google AI Studio](https://aistudio.google.com/apikey)
- **افحص أسماء الموديلات الحالية** في AI Studio قبل النشر (بتتغير باستمرار) وحدّث `GEMINI_GENERATION_MODEL` و`GEMINI_EMBEDDING_MODEL` في env

### 3. Telegram bot
- اعمل بوت جديد عن طريق [@BotFather](https://t.me/BotFather) وخد التوكن
- هات الـ chat ID بتاعك (ابعت أي رسالة للبوت @userinfobot مثلاً) وحطه في `ADMIN_CHAT_IDS`

### 4. Deploy على Vercel
```bash
npm install
vercel deploy
```
ضيف الـ environment variables دي في إعدادات المشروع على Vercel (نفس أسماء `.env.example`):
`TELEGRAM_BOT_TOKEN`, `ADMIN_CHAT_IDS`, `GEMINI_API_KEY`, `GEMINI_GENERATION_MODEL`,
`GEMINI_EMBEDDING_MODEL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BATCH_SIZE`,
`TOP_K_CHUNKS`, `MAX_DAILY_GEMINI_CALLS`

### 5. اربط webhook تيليجرام بالدومين بتاعك
```bash
curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://your-project.vercel.app/api/telegram-webhook"
```

## ⚠️ ملاحظة عن Vercel plan

`vercel.json` بيحدد `maxDuration: 300` ثانية (5 دقايق) — وده متاح فعلاً على **Hobby plan المجاني** طالما fluid compute شغال (افتراضي على المشاريع الجديدة)، فمش محتاج ترقية لـ Pro عشان الـ timeout بس. الـ 5 دقايق دول كفاية جدًا لمعالجة 100 سؤال (~7-10 نداءات لـ Gemini).

## Environment variables على Vercel

مش محتاج ملف `.env` في المشروع خالص — ضيف المتغيرات دي من Vercel Dashboard مباشرة:
`Project → Settings → Environment Variables`

نفس الأسماء الموجودة في `.env.example` (استخدمه كمرجع بس، مش هيتقرأ في الإنتاج):
`TELEGRAM_BOT_TOKEN`, `ADMIN_CHAT_IDS`, `GEMINI_API_KEY`, `GEMINI_GENERATION_MODEL`,
`GEMINI_EMBEDDING_MODEL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `BATCH_SIZE`,
`TOP_K_CHUNKS`, `MAX_DAILY_GEMINI_CALLS`

## الأوامر

- إرسال PDF من حساب أدمن → رفع/استبدال الكتاب الحالي
- إرسال PDF أو TXT من أي حد → استخراج الأسئلة منه والإجابة عليها (لحد 100 سؤال)
- إرسال نص عادي (سؤال في كل سطر، أو سؤال واحد) → إجابة مباشرة
- `/status` (أدمن بس) → حالة الكتاب الحالي (جاهز / قيد المعالجة / خطأ)

## تطويرات مستقبلية (مش موجودة في النسخة دي عن قصد)

- استخراج أسئلة من ملفات سكان (يحتاج Gemini File API + OCR)
- تنبيهات تقدم أدق أثناء معالجة كتاب كبير جدًا
- Rate limiting على مستوى المستخدم الواحد (حاليًا الحد يومي عالمي بس عن طريق `MAX_DAILY_GEMINI_CALLS`)


const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env.GEMINI_API_KEY) {
      return json({ error: "مفتاح Gemini غير مضبوط في Cloudflare." }, 500);
    }

    const form = await request.formData();
    const image = form.get("image");

    if (!image || typeof image.arrayBuffer !== "function") {
      return json({ error: "يرجى اختيار صورة الوصفة الطبية." }, 400);
    }

    if (image.size > 8 * 1024 * 1024) {
      return json({ error: "حجم الصورة أكبر من 8 ميجابايت." }, 400);
    }

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "image/heif"
    ];

    if (!allowedTypes.includes(image.type)) {
      return json({ error: "نوع الصورة غير مدعوم." }, 400);
    }

    const base64 = toBase64(new Uint8Array(await image.arrayBuffer()));

    const prompt = `
اقرأ صورة الوصفة الطبية المرفقة قراءة بصرية دقيقة.

أعد النتيجة بصيغة JSON فقط، دون Markdown.

المطلوب:
- اسم المريض إن كان واضحاً.
- تاريخ الوصفة إن كان واضحاً.
- أسماء الأدوية كما تظهر مكتوبة.
- تركيز كل دواء.
- تعليمات الجرعة كما تظهر فقط.
- مدة الاستخدام إن كانت مكتوبة.
- مستوى الثقة: high أو medium أو low.
- التعليمات الأخرى والتحذيرات.
- الأجزاء غير المقروءة أو غير المؤكدة.

قواعد مهمة:
1. لا تخمّن اسم دواء أو جرعة أو تركيز.
2. لا تستنتج الجرعة من اسم الدواء.
3. إذا تعذرت قراءة كلمة فاكتب "غير واضح".
4. احتفظ باسم الدواء كما هو مكتوب، ولا تستبدله باسم مشابه.
5. لا تقدم توصيات علاجية أو تغيّر تعليمات الطبيب.
6. إذا لم توجد أدوية واضحة فأعد medicines كمصفوفة فارغة.

استخدم هذا الهيكل:
{
  "patient_name": "",
  "prescription_date": "",
  "medicines": [
    {
      "name_as_written": "",
      "strength": "",
      "dose_instructions": "",
      "duration": "",
      "confidence": "low"
    }
  ],
  "other_instructions": "",
  "general_warnings": [],
  "uncertain_parts": []
}
`;

    const apiResponse = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": env.GEMINI_API_KEY
        },
        body: JSON.stringify({
          contents: [{
            parts: [
              { text: prompt },
              {
                inline_data: {
                  mime_type: image.type,
                  data: base64
                }
              }
            ]
          }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.1
          }
        })
      }
    );

    const result = await apiResponse.json();

    if (!apiResponse.ok) {
      return json({
        error: "تعذر تحليل الصورة عبر Gemini. تحقق من إعداد المفتاح أو الخدمة."
      }, 502);
    }

    const output = result.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("");

    if (!output) {
      return json({ error: "لم يتمكن الذكاء الاصطناعي من قراءة الصورة." }, 502);
    }

    let data;

    try {
      data = JSON.parse(output);
    } catch {
      return json({ error: "تعذر تحويل نتيجة القراءة إلى بيانات منظمة." }, 502);
    }

    return json({
      patient_name: data.patient_name || "",
      prescription_date: data.prescription_date || "",
      medicines: Array.isArray(data.medicines) ? data.medicines : [],
      other_instructions: data.other_instructions || "",
      general_warnings: Array.isArray(data.general_warnings) ? data.general_warnings : [],
      uncertain_parts: Array.isArray(data.uncertain_parts) ? data.uncertain_parts : []
    });

  } catch (error) {
    return json({ error: "حدث خطأ أثناء معالجة الوصفة. حاول مرة أخرى." }, 500);
  }
}


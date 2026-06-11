import { z } from 'zod';

// Result of the per-page vision analysis. Box coordinates are normalized to
// 0-1000 in both axes (Gemini's bounding-box convention).
export const AnalysisSchema = z.object({
  holes: z
    .array(
      z.object({
        box: z.object({
          ymin: z.number(),
          xmin: z.number(),
          ymax: z.number(),
          xmax: z.number()
        }),
        overText: z.boolean().default(false),
        nearbyText: z.string().default('')
      })
    )
    .default([]),
  residualSkewDeg: z.number().default(0),
  qualityFlags: z.array(z.string()).default([])
});

// Same schema as Gemini structured-output responseSchema.
export const analysisResponseSchema = {
  type: 'OBJECT',
  properties: {
    holes: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          box: {
            type: 'OBJECT',
            properties: {
              ymin: { type: 'NUMBER' },
              xmin: { type: 'NUMBER' },
              ymax: { type: 'NUMBER' },
              xmax: { type: 'NUMBER' }
            },
            required: ['ymin', 'xmin', 'ymax', 'xmax']
          },
          overText: { type: 'BOOLEAN' },
          nearbyText: { type: 'STRING' }
        },
        required: ['box']
      }
    },
    residualSkewDeg: { type: 'NUMBER' },
    qualityFlags: { type: 'ARRAY', items: { type: 'STRING' } }
  },
  required: ['holes']
};

export const ANALYSIS_PROMPT = `You are inspecting one page of a high-resolution grayscale scan of a printed book.
The physical book was hole-punched, so pages can show punch-hole damage: solid black filled circles
(roughly 5-8 mm), or white circular gaps where a hole already removed paper. Damage usually sits in
the upper part of the page near the inner edge and sometimes overlaps printed text (e.g. a running header).

Report:
1. "holes": every punch-hole damage spot, each with a TIGHT bounding box in coordinates normalized
   to 0-1000 on both axes ({ymin, xmin, ymax, xmax}), "overText": true when the damage touches printed
   text or rules/lines, and "nearbyText": the exact printed text within about two lines around the
   damage (helps reconstruction; empty string if none).
   Do NOT report: page numbers, bullet points, illustration content, or specks smaller than ~2 mm.
2. "residualSkewDeg": remaining rotation of the text lines in degrees (positive = page content tilted
   clockwise), 0 if perfectly straight.
3. "qualityFlags": list from [smudge, low-contrast, content-cut-off, ghosting, bleed-through] that
   apply, otherwise an empty array.

Respond with JSON only.`;

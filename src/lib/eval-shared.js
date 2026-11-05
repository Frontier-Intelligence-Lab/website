// Constants the Evaluate page and the server both use. This module has no imports: it is the only
// evaluation module the web bundle (and the Docker build stage) includes. Everything that validates,
// scores or identifies findings stays in eval.js, which is server-side and uses node:crypto.

export const PLANNED = [
  'Semantic near-duplicate detection',
  'Automatic verification that a source document is true',
  'A guarantee that personal data has been removed',
  'Proof that the case set covers future questions',
  'Calling a model endpoint, running an uploaded scorer, or starting a training job',
];

export const SYNTHETIC_CASES = `{"id":"case-returns-window","input":"How long does a customer have to return an unopened synthetic demo kettle?","expectedAnswer":"30 days from delivery","reviewCriteria":"Name the 30-day window and that it starts at delivery.","category":"returns","severity":"critical","sources":[{"projectId":"00000000-0000-4000-8000-000000000001","versionId":"00000000-0000-4000-8000-000000000002","fileId":"00000000-0000-4000-8000-000000000003"}]}
{"id":"case-warranty-power","input":"The synthetic demo kettle will not power on. What should the agent do?","expectedAnswer":"Ask for the order number and offer a replacement. Do not promise a refund before the order is found.","reviewCriteria":null,"category":"warranty","severity":"major","sources":[{"projectId":"00000000-0000-4000-8000-000000000001","versionId":"00000000-0000-4000-8000-000000000002"}]}
{"id":"case-store-hours","input":"What time does the synthetic demo shop close on Sunday?","expectedAnswer":null,"reviewCriteria":"The answer must match the Sunday hours in the cited policy, or say the policy does not state them.","category":"hours","severity":"minor","sources":[{"projectId":"00000000-0000-4000-8000-000000000001","versionId":"00000000-0000-4000-8000-000000000002","fileId":"00000000-0000-4000-8000-000000000003"}]}
`;

export const SYNTHETIC_PREDICTIONS = `{"id":"case-returns-window","status":"answered","output":"You can return an unopened kettle within 30 days of delivery."}
{"id":"case-warranty-power","status":"answered","output":"I can refund you right now."}
{"id":"case-store-hours","status":"error","error":"timeout"}
`;

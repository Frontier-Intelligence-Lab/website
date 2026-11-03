// Synthetic workspace shown to invited reviewers. Not real customers, buyers, lenders or results.

export const LIFECYCLE = ['Collect', 'Label', 'Train', 'Evaluate', 'Deploy'];

// Sections of the overview stand in for pages that are not built yet.
export const NAV = [
  { items: [{ label: 'Overview', icon: 'home', href: '#overview', current: true }, { label: 'Projects', icon: 'grid', href: '#projects' }] },
  {
    label: 'Data',
    items: [
      { label: 'Catalog', icon: 'book', href: '#listings' },
      { label: 'Collection', icon: 'upload', href: '#collection' },
      { label: 'Labeling', icon: 'tag', href: '#collection' },
      { label: 'My datasets', icon: 'layers', href: '#listings' },
      { label: 'Listings & sales', icon: 'store', href: '#listings' },
    ],
  },
  {
    label: 'Models',
    items: [
      { label: 'Training', icon: 'chip', href: '#training' },
      { label: 'Evaluations', icon: 'chart', href: '#training' },
      { label: 'Deployments', icon: 'server', href: '#training' },
    ],
  },
  {
    label: 'Capital & trust',
    items: [
      { label: 'Financing', icon: 'bank', href: '#financing' },
      { label: 'Rights & consent', icon: 'shield', href: '#attention' },
      { label: 'Audit log', icon: 'clock', href: '#attention' },
    ],
  },
];

export const KPIS = [
  { label: 'Licensed data', value: '41.2 TB', note: '18 datasets · 3 renewals due' },
  { label: 'Labels this week', value: '86,400', note: '94.1% reviewer agreement' },
  { label: 'Training', value: '3 runs', note: '1,920 GPU-hours this month' },
  { label: 'Data sales, Q4', value: '$48,200', note: '$33,740 owed to contributors' },
  { label: 'Financing request', value: '$2.5M', note: 'Under review · 2 lenders', tone: 'info' },
];

// step 6 = deployed (past the last stage).
export const PROJECTS = [
  { name: 'Pick-and-place policy', data: 'Robot trajectories', step: 1, now: '1,240 of 2,000 episodes collected', updated: 'Nov 2' },
  { name: 'Visual defect inspection', data: 'Images', step: 2, now: 'QA hold on batch 14', tone: 'warn', updated: 'Nov 2' },
  { name: 'Predictive maintenance', data: 'Sensor time series', step: 3, now: 'Run 3 at 64% · about 3 h left', updated: 'Nov 1' },
  { name: 'Document extraction', data: 'Text & documents', step: 4, now: 'v4 ready to compare', tone: 'info', updated: 'Oct 31' },
  { name: 'Floor safety audio', data: 'Audio', step: 6, now: 'Live on edge-02 (on-prem)', tone: 'ok', updated: 'Oct 28' },
];

export const ATTENTION = [
  { kind: 'Rights review', tone: 'warn', icon: 'shieldAlert', text: '2 consent records missing in Teleop episodes v3', action: 'Review', href: '#collection' },
  { kind: 'Labeling QA', tone: 'warn', icon: 'tag', text: 'Agreement fell to 81% on defect boxes, batch 14', action: 'Open', href: '#collection' },
  { kind: 'Evaluation', tone: 'info', icon: 'chart', text: 'Doc extraction v4 beats v3 on 6 of 7 checks', action: 'Compare', href: '#training' },
  { kind: 'Financing', tone: 'info', icon: 'bank', text: 'Lender A asked for Q3 fleet utilization', action: 'Reply', href: '#financing' },
  { kind: 'Contributor payouts', tone: 'plain', icon: 'people', text: 'October batch: $12,480 to 38 contributors', action: 'Approve', href: '#listings' },
];

export const CAMPAIGNS = [
  { name: 'Warehouse teleop episodes', pct: 62, note: '38 paid contributors · closes Nov 20' },
  { name: 'Line-camera defect capture', pct: 100, note: '48,000 images · in labeling' },
];

export const RUNS = [
  { name: 'doc-extract-v4', note: 'Field F1 0.91 vs 0.86 baseline', status: 'Evaluated', tone: 'info' },
  { name: 'pm-forecaster-r3', note: '8× H100 · 64% · ETA 3 h', status: 'Training', tone: 'plain' },
  { name: 'defect-det-v2', note: 'Waiting on batch 14 labels', status: 'Blocked', tone: 'warn' },
];

export const FINANCING = {
  title: 'Fleet expansion · $2.5M',
  summary: '40 palletizing cells and training compute. Shared with Lender A and Lender B: 14 documents, read-only. Raw supplier data and model weights excluded.',
  steps: ['Drafted', 'Submitted', 'Under review', 'Offer', 'Agreement'],
  current: 2,
};

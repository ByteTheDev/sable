/**
 * Mermaid, loaded only when a diagram first comes near the viewport (its own chunk; nothing in the
 * start-up bundle). Themed in Sable's monochrome: ink nodes, hairline borders, ivory text, grey
 * lines. The SVG it produces is shown in a widget frame, so even a flaw in Mermaid cannot reach
 * the app.
 */

type Mermaid = (typeof import('mermaid'))['default'];

const INK = {
  sheet: '#0c0c0e',
  panel: '#121214',
  panel2: '#18181b',
  panel3: '#1f1f23',
  panel4: '#27272c',
  edge: '#3a3a40',
  edgeSoft: '#2c2c31',
  text: '#f2f1ee',
  text2: '#aeada9',
  text3: '#7a7975',
  text4: '#54534f',
  inverse: '#0a0a0b',
};

const FONT = "'Inter Variable', Inter, ui-sans-serif, system-ui, 'Segoe UI', sans-serif";

const RAMP = [INK.text, INK.text2, INK.text3, INK.text4, '#3f3f45', INK.panel4, '#d6d4cf', '#8f8e8a', '#66655f', '#46464b', '#323237', '#1f1f23'];

const themeVariables: Record<string, string | boolean> = {
  darkMode: true,
  background: INK.sheet,
  fontFamily: FONT,
  fontSize: '13px',
  primaryColor: INK.panel2,
  primaryTextColor: INK.text,
  primaryBorderColor: INK.edge,
  secondaryColor: INK.panel3,
  secondaryTextColor: INK.text,
  secondaryBorderColor: INK.edge,
  tertiaryColor: INK.panel,
  tertiaryTextColor: INK.text2,
  tertiaryBorderColor: INK.edgeSoft,
  mainBkg: INK.panel2,
  nodeBorder: INK.edge,
  nodeTextColor: INK.text,
  lineColor: INK.text3,
  textColor: INK.text2,
  titleColor: INK.text,
  clusterBkg: '#0f0f11',
  clusterBorder: INK.edgeSoft,
  edgeLabelBackground: INK.sheet,
  noteBkgColor: INK.panel3,
  noteTextColor: INK.text2,
  noteBorderColor: INK.edge,
  actorBkg: INK.panel2,
  actorBorder: INK.edge,
  actorTextColor: INK.text,
  actorLineColor: INK.text4,
  signalColor: INK.text2,
  signalTextColor: INK.text2,
  labelBoxBkgColor: INK.panel2,
  labelBoxBorderColor: INK.edge,
  labelTextColor: INK.text,
  loopTextColor: INK.text2,
  activationBkgColor: INK.panel4,
  activationBorderColor: INK.text4,
  sequenceNumberColor: INK.inverse,
  pieStrokeColor: INK.sheet,
  pieStrokeWidth: '1px',
  pieOuterStrokeColor: INK.panel4,
  pieTitleTextColor: INK.text,
  pieSectionTextColor: INK.inverse,
  pieLegendTextColor: INK.text2,
  sectionBkgColor: INK.panel2,
  altSectionBkgColor: INK.panel,
  sectionBkgColor2: INK.panel3,
  taskBkgColor: INK.panel4,
  taskBorderColor: INK.edge,
  taskTextColor: INK.text,
  taskTextLightColor: INK.text,
  taskTextOutsideColor: INK.text2,
  activeTaskBkgColor: INK.text3,
  activeTaskBorderColor: INK.text2,
  doneTaskBkgColor: INK.edge,
  doneTaskBorderColor: INK.text4,
  critBkgColor: INK.text,
  critBorderColor: INK.text,
  gridColor: INK.panel4,
  todayLineColor: INK.text2,
  classText: INK.text,
  labelColor: INK.text,
  attributeBackgroundColorOdd: INK.panel2,
  attributeBackgroundColorEven: INK.panel,
  errorBkgColor: '#2a1414',
  errorTextColor: '#f0a49a',
  quadrant1Fill: INK.panel2,
  quadrant2Fill: INK.panel,
  quadrant3Fill: INK.panel,
  quadrant4Fill: INK.panel2,
  quadrantPointFill: INK.text,
  quadrantTitleFill: INK.text,
  quadrantXAxisTextFill: INK.text2,
  quadrantYAxisTextFill: INK.text2,
};
RAMP.forEach((c, i) => {
  themeVariables[`pie${i + 1}`] = c;
  themeVariables[`cScale${i}`] = i % 2 ? INK.panel3 : INK.panel2;
  themeVariables[`cScaleLabel${i}`] = INK.text;
  themeVariables[`git${i}`] = RAMP[i % 6];
  themeVariables[`gitBranchLabel${i}`] = INK.inverse;
  themeVariables[`fillType${i}`] = i % 2 ? INK.panel3 : INK.panel2;
});

const themeCSS = `
  .node rect, .node polygon, .node path { stroke-width: 1px; }
  .node rect { rx: 8px; ry: 8px; }
  .cluster rect { rx: 10px; ry: 10px; stroke-width: 1px; }
  .flowchart-link, .edgePath .path, .relation, .messageLine0, .messageLine1, .transition { stroke-width: 1.25px; }
  .edgeLabel, .edgeLabel p, .edgeLabel rect { background-color: ${INK.sheet}; fill: ${INK.sheet}; color: ${INK.text2}; }
  /* A little ground either side, so an edge stops short of its label instead of running into it. */
  .edgeLabel p { padding: 0 5px; }
  .label, .nodeLabel, .edgeLabel { font-weight: 450; letter-spacing: -0.003em; }
  /* Labels are measured in the app's document, where the app's own .label rule (ui.css, 12px) would
     reach them, and shown in the widget frame, where it does not: pin the size so both agree. */
  .label { font-size: inherit; }
  .actor { stroke-width: 1px; }
  .note { stroke-width: 1px; }
  text.actor > tspan { font-weight: 500; }
`;

let loading: Promise<Mermaid> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let seq = 0;

function load(): Promise<Mermaid> {
  loading ??= import('mermaid').then((m) => {
    const mm = m.default;
    mm.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables,
      themeCSS,
      fontFamily: FONT,
      flowchart: { curve: 'basis', padding: 14, nodeSpacing: 46, rankSpacing: 52, htmlLabels: true },
      sequence: { actorMargin: 56, boxMargin: 8, mirrorActors: false, messageFontWeight: 400 },
      gantt: { barHeight: 18, barGap: 6, fontSize: 12, sectionFontSize: 12 },
    } as Parameters<Mermaid['initialize']>[0]);
    return mm;
  });
  return loading;
}

/** Labels are drawn at 13px (themeVariables.fontSize); scaled further down than 11.5px they stop being legible. */
export const MIN_DIAGRAM_SCALE = 11.5 / 13;

/**
 * A diagram shrinks to fit its column only down to MIN_DIAGRAM_SCALE; wider than that, it keeps
 * that size and its block scrolls sideways. Sets a min-width (from the viewBox) on the root <svg>,
 * which also becomes a centred block.
 */
export function fitDiagram(svg: string): string {
  const open = /<svg\b[^>]*>/.exec(svg);
  if (!open) return svg;
  const vb = /\sviewBox="\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+[\d.e]+\s*"/.exec(open[0]);
  const width = vb ? Number(vb[1]) : 0;
  // Sequence diagrams draw their smallest text (actors) at Mermaid's own 14px, not at fontSize.
  const scale = /aria-roledescription="sequence"/.test(open[0]) ? 11.5 / 14 : MIN_DIAGRAM_SCALE;
  const add = `${width > 0 ? `min-width:${Math.ceil(width * scale)}px;` : ''}display:block;margin:0 auto;`;
  const tag = /\sstyle="/.test(open[0]) ? open[0].replace(/\sstyle="/, ` style="${add}`) : open[0].replace(/^<svg\b/, `<svg style="${add}"`);
  return svg.slice(0, open.index) + tag + svg.slice(open.index + open[0].length);
}

/** Renders one diagram to an SVG string. Calls run one at a time (Mermaid keeps global state). */
export function renderMermaid(code: string): Promise<string> {
  const run = queue.then(async () => {
    const mm = await load();
    const id = `sable-mm-${++seq}`;
    try {
      const { svg } = await mm.render(id, code);
      return fitDiagram(svg);
    } finally {
      // Mermaid leaves its scratch element behind when a diagram fails.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => {});
  return run;
}

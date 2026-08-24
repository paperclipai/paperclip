(globalThis.TURBOPACK||(globalThis.TURBOPACK=[])).push(["object"==typeof document?document.currentScript:void 0,241489,e=>{"use strict";e.s(["setupViewPortForSVG",()=>r]);var t=e.i(311495),i=e.i(56562),r=(0,i.__name)((e,r,l,o)=>{e.attr("class",l);let{width:n,height:c,x:d,y:g}=s(e,r);(0,t.configureSvgSize)(e,c,n,o);let u=a(d,g,n,c,r);e.attr("viewBox",u),i.log.debug(`viewBox configured: ${u} with padding: ${r}`)},"setupViewPortForSVG"),s=(0,i.__name)((e,t)=>{let i=e.node()?.getBBox()||{width:0,height:0,x:0,y:0};return{width:i.width+2*t,height:i.height+2*t,x:i.x,y:i.y}},"calculateDimensionsWithPadding"),a=(0,i.__name)((e,t,i,r,s)=>`${e-s} ${t-s} ${i} ${r}`,"createViewBox")},756637,e=>{"use strict";e.s(["getDiagramElement",()=>r]);var t=e.i(56562);e.i(947716);var i=e.i(723685),r=(0,t.__name)((e,t)=>{let r;return"sandbox"===t&&(r=(0,i.select)("#i"+e)),("sandbox"===t?(0,i.select)(r.nodes()[0].contentDocument.body):(0,i.select)("body")).select(`[id="${e}"]`)},"getDiagramElement")},303071,e=>{"use strict";e.s(["getIconStyles",()=>t]);var t=(0,e.i(56562).__name)(()=>`
  /* Font Awesome icon styling - consolidated */
  .label-icon {
    display: inline-block;
    height: 1em;
    overflow: visible;
    vertical-align: -0.125em;
  }
  
  .node .label-icon path {
    fill: currentColor;
    stroke: revert;
    stroke-width: revert;
  }
`,"getIconStyles")},802312,e=>{"use strict";e.s(["diagram",()=>r]);var t=e.i(103975);e.i(303071),e.i(756637),e.i(241489),e.i(147603),e.i(20401),e.i(455304),e.i(651868),e.i(48339),e.i(504384),e.i(487404),e.i(905664),e.i(311495);var i=e.i(56562),r={parser:t.classDiagram_default,get db(){return new t.ClassDB},renderer:t.classRenderer_v3_unified_default,styles:t.styles_default,init:(0,i.__name)(e=>{e.class||(e.class={}),e.class.arrowMarkerAbsolute=e.arrowMarkerAbsolute},"init")}}]);
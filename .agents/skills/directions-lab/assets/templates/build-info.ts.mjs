export const envDts = (ctx) => `declare const ${ctx.buildDefine}: string | undefined;
`;

export default (ctx) => `export const LAB_BUILD: string = typeof ${ctx.buildDefine} === "string" ? ${ctx.buildDefine} : "dev";
`;

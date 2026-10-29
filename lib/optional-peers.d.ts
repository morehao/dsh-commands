// 仅类型声明：@deepseek-ai/dsh-llm / dsh-tools 是 optional peerDependency，
// 运行时在 apply() 里按需动态 import，编译期不能因未安装报 TS2307。
// 这里只给最小形状，返回值按 any 处理；不给生产代码引入真实依赖。
declare module '@deepseek-ai/dsh-llm' {
  export function createUserMessage(input: any): any;
}
declare module '@deepseek-ai/dsh-tools' {
  export const defineTool: (definition: any) => any;
}

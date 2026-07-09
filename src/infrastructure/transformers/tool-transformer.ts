export function convertToolsToCodeWhisperer(tools: any[]): any[] {
  return tools.map((t) => ({
    toolSpecification: {
      name: t.name || t.function?.name,
      description: (t.description || t.function?.description || '').substring(0, 9216),
      inputSchema: { json: t.input_schema || t.function?.parameters || {} }
    }
  }))
}

export function deduplicateToolResults(trs: any[]): any[] {
  const u: any[] = [],
    s = new Set()
  for (const t of trs) {
    if (!s.has(t.toolUseId)) {
      s.add(t.toolUseId)
      u.push(t)
    }
  }
  return u
}

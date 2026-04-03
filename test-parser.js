// 测试解析器修复
const testCases = [
  {
    name: '缺少工具名称的 XML 格式（只有 arguments）',
    input: '<tool_call>\n<arguments>{"file_path": "src/kiro/token_manager.rs"}</arguments>\n</tool_call>',
    expected: { name: 'Read', arguments: { file_path: 'src/kiro/token_manager.rs' } }
  },
  {
    name: '带有 name 属性的 tool_call',
    input: '<tool_call name="Read">\n<arguments>{"file_path": "test.rs"}</arguments>\n</tool_call>',
    expected: { name: 'Read', arguments: { file_path: 'test.rs' } }
  },
  {
    name: 'JSON 格式',
    input: '<tool_call>\n{"name": "Read", "arguments": {"file_path": "test.rs"}}\n</tool_call>',
    expected: { name: 'Read', arguments: { file_path: 'test.rs' } }
  },
  {
    name: 'Windows 路径带特殊字符',
    input: '<tool_call>\n{"name": "Read", "arguments": {"file_path": "C:\\\\Users\\\\test (2)\\\\file.rs"}}\n</tool_call>',
    expected: { name: 'Read', arguments: { file_path: 'C:\\Users\\test (2)\\file.rs' } }
  }
];

console.log('测试用例：');
testCases.forEach((tc, i) => {
  console.log(`\n${i + 1}. ${tc.name}`);
  console.log('输入:', tc.input);
  console.log('期望:', tc.expected);
});

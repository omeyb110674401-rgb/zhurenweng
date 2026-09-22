import eslint from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'data/**',
      'drizzle/**',
      'fixtures/**',
      'next-env.d.ts',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    plugins: {
      '@next/next': nextPlugin,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs['core-web-vitals'].rules,
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['worker/**/*.ts', 'tests/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    /**
     * 附件解析的重型依赖只能被解析层与 worker 导入（issue #57）。
     *
     * 为什么要机器拦而不是靠自觉：pdfjs-dist 解包 35MB，一旦哪天有人在详情页的 server
     * component 里 `import { parseAttachment }`，Next 就会把它卷进 web 运行期包 —— 镜像
     * 变大是静默发生的（#51 已经记了 devDependencies 也在镜像里的债）。这条规则把这个
     * 失败模式变成一条报错。
     */
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.mjs'],
    ignores: ['src/lib/attachments/**', 'worker/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['pdfjs-dist*', 'word-extractor*'],
              message:
                '附件解析依赖（pdfjs-dist / word-extractor，合计约 35MB）只允许从 src/lib/attachments/** 或 worker/** 导入，否则会被卷进 web 运行期包（issue #57）。',
            },
          ],
        },
      ],
    },
  },
);

import tseslint from 'typescript-eslint';
import reactPlugin from '@eslint-react/eslint-plugin';
import reactHooksPlugin from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['.output/**', 'native-host/dist/**', '.wxt/**', 'dev-scripts/**'] },
  ...tseslint.configs.recommended,
  reactPlugin.configs['recommended-typescript'],
  {
    plugins: {
      'react-hooks': reactHooksPlugin,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
    },
  },
);

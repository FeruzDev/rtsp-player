/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testTimeout: 30000,
  transform: {
    '^.+\.tsx?$': ['ts-jest', { tsconfig: { jsx: 'react', esModuleInterop: true, module: 'commonjs', moduleResolution: 'node', isolatedModules: true } }],
  },
};

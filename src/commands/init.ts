import chalk from 'chalk';
import inquirer from 'inquirer';
import ora from 'ora';
import fs from 'fs-extra';
import path from 'path';
import { execSync } from 'child_process';
import { logger } from '../utils/logger';
import { CirronApi } from '../utils/api';
import { ConfigManager } from '../utils/config';
import type { InitOptions, ProjectConfig, Template } from '../types';

const TEMPLATES: Record<string, Template> = {
  nextjs: {
    name: 'Next.js',
    description: 'React framework with SSR/SSG support',
    repository: 'https://github.com/vercel/next.js/tree/canary/examples/hello-world',
    files: [],
    postInstall: ['npm install', 'npm run build']
  },
  react: {
    name: 'React',
    description: 'React single-page application',
    files: [],
    postInstall: ['npm install', 'npm run build']
  },
  vue: {
    name: 'Vue.js',
    description: 'Progressive JavaScript framework',
    files: [],
    postInstall: ['npm install', 'npm run build']
  },
  express: {
    name: 'Express.js',
    description: 'Node.js web framework',
    files: [],
    postInstall: ['npm install']
  },
  static: {
    name: 'Static Site',
    description: 'Plain HTML/CSS/JS website',
    files: [],
    postInstall: []
  }
};

export async function initCommand(projectName?: string, options: InitOptions = { template: 'nextjs' }): Promise<void> {
  try {
    // Get project name if not provided
    if (!projectName) {
      const answers = await inquirer.prompt([
        {
          type: 'input',
          name: 'name',
          message: 'Project name:',
          default: 'my-cirron-project',
          validate: (input: string) => {
            if (!input.trim()) {
              return 'Project name is required';
            }
            if (!/^[a-zA-Z0-9-_]+$/.test(input)) {
              return 'Project name can only contain letters, numbers, hyphens, and underscores';
            }
            return true;
          }
        }
      ]);
      projectName = answers.name;
    }

    const projectPath = path.resolve(process.cwd(), projectName);

    // Check if directory exists and is not empty
    if (fs.existsSync(projectPath)) {
      const files = fs.readdirSync(projectPath);
      if (files.length > 0 && !options.force) {
        const answers = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'continue',
            message: `Directory ${projectName} is not empty. Continue anyway?`,
            default: false
          }
        ]);
        
        if (!answers.continue) {
          logger.info('Initialization cancelled');
          return;
        }
      }
    }

    // Template selection if not specified
    let template = options.template;
    if (!TEMPLATES[template]) {
      const answers = await inquirer.prompt([
        {
          type: 'list',
          name: 'template',
          message: 'Choose a template:',
          choices: Object.entries(TEMPLATES).map(([key, template]) => ({
            name: `${template.name} - ${template.description}`,
            value: key
          }))
        }
      ]);
      template = answers.template;
    }

    const selectedTemplate = TEMPLATES[template];
    const spinner = ora(`Creating ${selectedTemplate.name} project...`).start();

    try {
      // Create project directory
      await fs.ensureDir(projectPath);

      // Create project files based on template
      await createProjectFiles(projectPath, projectName, template);

      // Initialize git if requested
      if (options.git) {
        spinner.text = 'Initializing git repository...';
        try {
          execSync('git init', { cwd: projectPath, stdio: 'pipe' });
          execSync('git add .', { cwd: projectPath, stdio: 'pipe' });
          execSync('git commit -m "Initial commit"', { cwd: projectPath, stdio: 'pipe' });
          logger.info('Git repository initialized');
        } catch (error) {
          logger.warn('Failed to initialize git repository');
        }
      }

      // Install dependencies if requested
      if (options.install && selectedTemplate.postInstall.length > 0) {
        spinner.text = 'Installing dependencies...';
        for (const command of selectedTemplate.postInstall) {
          try {
            execSync(command, { cwd: projectPath, stdio: 'pipe' });
          } catch (error) {
            logger.warn(`Failed to run: ${command}`);
          }
        }
      }

      // Register project with Cirron API (if authenticated)
      const config = new ConfigManager();
      const currentConfig = config.load();
      
      if (currentConfig.token) {
        spinner.text = 'Registering project with Cirron...';
        try {
          const api = new CirronApi(currentConfig);
          await api.createProject({
            name: projectName,
            template,
            path: projectPath
          });
          logger.info('Project registered with Cirron');
        } catch (error) {
          logger.warn('Failed to register project with Cirron (continuing anyway)');
        }
      }

      spinner.succeed(chalk.green(`Project ${projectName} created successfully!`));

      // Show next steps
      console.log();
      logger.info(chalk.bold('Next steps:'));
      logger.info(`  ${chalk.cyan(`cd ${projectName}`)}`);
      
      if (!options.install && selectedTemplate.postInstall.length > 0) {
        logger.info(`  ${chalk.cyan('npm install')}`);
      }
      
      logger.info(`  ${chalk.cyan('cirron build')}`);
      logger.info(`  ${chalk.cyan('cirron deploy')}`);

      if (!currentConfig.token) {
        console.log();
        logger.info(chalk.yellow('💡 Tip: Run ') + chalk.cyan('cirron auth login') + chalk.yellow(' to connect to Cirron'));
      }

    } catch (error) {
      spinner.fail(chalk.red('Project creation failed'));
      throw error;
    }

  } catch (error) {
    logger.error('Failed to initialize project:', error);
    process.exit(1);
  }
}

async function createProjectFiles(projectPath: string, projectName: string, template: string): Promise<void> {
  // Create cirron.config.json
  const projectConfig: ProjectConfig = {
    name: projectName,
    version: '1.0.0',
    template,
    environments: {
      development: {
        name: 'development',
        url: 'http://localhost:3000'
      },
      staging: {
        name: 'staging'
      },
      production: {
        name: 'production'
      }
    },
    build: {
      outputDir: template === 'nextjs' ? '.next' : 'dist',
      command: template === 'nextjs' ? 'npm run build' : 'npm run build'
    },
    deploy: {
      provider: 'custom',
      settings: {}
    }
  };

  await fs.writeJSON(path.join(projectPath, 'cirron.config.json'), projectConfig, { spaces: 2 });

  // Create template-specific files
  switch (template) {
    case 'nextjs':
      await createNextJSFiles(projectPath, projectName);
      break;
    case 'react':
      await createReactFiles(projectPath, projectName);
      break;
    case 'vue':
      await createVueFiles(projectPath, projectName);
      break;
    case 'express':
      await createExpressFiles(projectPath, projectName);
      break;
    case 'static':
      await createStaticFiles(projectPath, projectName);
      break;
  }

  // Create common files
  await createCommonFiles(projectPath, projectName);
}

async function createNextJSFiles(projectPath: string, projectName: string): Promise<void> {
  const packageJson = {
    name: projectName,
    version: '0.1.0',
    private: true,
    scripts: {
      dev: 'next dev',
      build: 'next build',
      start: 'next start',
      lint: 'next lint'
    },
    dependencies: {
      next: '^14.0.0',
      react: '^18.0.0',
      'react-dom': '^18.0.0'
    },
    devDependencies: {
      '@types/node': '^20.0.0',
      '@types/react': '^18.0.0',
      '@types/react-dom': '^18.0.0',
      eslint: '^8.0.0',
      'eslint-config-next': '^14.0.0',
      typescript: '^5.0.0'
    }
  };

  await fs.writeJSON(path.join(projectPath, 'package.json'), packageJson, { spaces: 2 });

  // Create Vue app files
  await fs.ensureDir(path.join(projectPath, 'src'));
  await fs.writeFile(
    path.join(projectPath, 'src', 'App.vue'),
    `<template>
  <div id="app">
    <h1>Welcome to ${projectName}</h1>
    <p>Your Vue.js app is ready!</p>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

export default defineComponent({
  name: 'App'
});
</script>

<style>
#app {
  font-family: Avenir, Helvetica, Arial, sans-serif;
  text-align: center;
  color: #2c3e50;
  margin-top: 60px;
}
</style>
`
  );

  await fs.writeFile(
    path.join(projectPath, 'src', 'main.ts'),
    `import { createApp } from 'vue';
import App from './App.vue';

createApp(App).mount('#app');
`
  );

  await fs.ensureDir(path.join(projectPath, 'public'));
  await fs.writeFile(
    path.join(projectPath, 'public', 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1.0">
    <title>${projectName}</title>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`
  );
}

async function createExpressFiles(projectPath: string, projectName: string): Promise<void> {
  const packageJson = {
    name: projectName,
    version: '1.0.0',
    description: '',
    main: 'dist/index.js',
    scripts: {
      start: 'node dist/index.js',
      dev: 'ts-node src/index.ts',
      build: 'tsc',
      'build:watch': 'tsc --watch'
    },
    dependencies: {
      express: '^4.18.0',
      cors: '^2.8.5',
      helmet: '^7.0.0'
    },
    devDependencies: {
      '@types/express': '^4.17.0',
      '@types/cors': '^2.8.0',
      '@types/node': '^20.0.0',
      'ts-node': '^10.9.0',
      typescript: '^5.0.0'
    }
  };

  await fs.writeJSON(path.join(projectPath, 'package.json'), packageJson, { spaces: 2 });

  // Create Express app
  await fs.ensureDir(path.join(projectPath, 'src'));
  await fs.writeFile(
    path.join(projectPath, 'src', 'index.ts'),
    `import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Routes
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to ${projectName}',
    status: 'running'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(\`Server running on port \${PORT}\`);
});
`
  );

  // Create tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: 'ES2020',
      module: 'commonjs',
      outDir: './dist',
      rootDir: './src',
      strict: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
      resolveJsonModule: true,
      declaration: true,
      sourceMap: true
    },
    include: ['src/**/*'],
    exclude: ['node_modules', 'dist']
  };

  await fs.writeJSON(path.join(projectPath, 'tsconfig.json'), tsConfig, { spaces: 2 });
}

async function createStaticFiles(projectPath: string, projectName: string): Promise<void> {
  // Create basic HTML structure
  await fs.writeFile(
    path.join(projectPath, 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${projectName}</title>
    <link rel="stylesheet" href="styles.css">
</head>
<body>
    <header>
        <h1>Welcome to ${projectName}</h1>
    </header>
    
    <main>
        <p>Your static site is ready!</p>
    </main>
    
    <script src="script.js"></script>
</body>
</html>
`
  );

  await fs.writeFile(
    path.join(projectPath, 'styles.css'),
    `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    line-height: 1.6;
    color: #333;
    background-color: #f4f4f4;
}

header {
    background: #007acc;
    color: white;
    text-align: center;
    padding: 2rem 0;
}

main {
    max-width: 1200px;
    margin: 2rem auto;
    padding: 0 1rem;
    background: white;
    border-radius: 8px;
    box-shadow: 0 2px 5px rgba(0,0,0,0.1);
    padding: 2rem;
}

h1 {
    margin-bottom: 1rem;
}
`
  );

  await fs.writeFile(
    path.join(projectPath, 'script.js'),
    `// ${projectName} JavaScript
console.log('${projectName} loaded successfully!');

document.addEventListener('DOMContentLoaded', function() {
    // Your JavaScript code here
});
`
  );

  // Create a simple package.json for build tools
  const packageJson = {
    name: projectName,
    version: '1.0.0',
    description: 'Static website',
    scripts: {
      start: 'python -m http.server 8000 || python3 -m http.server 8000',
      build: 'echo "Static site - no build needed"'
    }
  };

  await fs.writeJSON(path.join(projectPath, 'package.json'), packageJson, { spaces: 2 });
}

async function createCommonFiles(projectPath: string, projectName: string): Promise<void> {
  // Create .gitignore
  await fs.writeFile(
    path.join(projectPath, '.gitignore'),
    `# Dependencies
node_modules/
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Production builds
dist/
build/
.next/
out/

# Environment variables
.env
.env.local
.env.development.local
.env.test.local
.env.production.local

# IDE
.vscode/
.idea/
*.swp
*.swo

# OS
.DS_Store
Thumbs.db

# Logs
*.log

# Runtime data
pids
*.pid
*.seed
*.pid.lock

# Coverage
coverage/
.nyc_output/

# Temporary folders
tmp/
temp/
`
  );

  // Create README.md
  await fs.writeFile(
    path.join(projectPath, 'README.md'),
    `# ${projectName}

Created with Cirron CLI.

## Getting Started

### Development
\`\`\`bash
npm install
npm run dev
\`\`\`

### Build
\`\`\`bash
cirron build
\`\`\`

### Deploy
\`\`\`bash
cirron deploy
\`\`\`

## Commands

- \`cirron build\` - Build the project
- \`cirron deploy\` - Deploy to your environment
- \`cirron status\` - Check project status
- \`cirron logs\` - View deployment logs

## Configuration

Edit \`cirron.config.json\` to customize build and deployment settings.

## Environment Variables

Use \`cirron env\` commands to manage environment variables:

\`\`\`bash
cirron env list
cirron env set KEY value
cirron env delete KEY
\`\`\`
`
  );

  // Create .env.example
  await fs.writeFile(
    path.join(projectPath, '.env.example'),
    `# Environment variables example
# Copy to .env and fill in your values

# API Configuration
API_URL=https://api.example.com
API_KEY=your_api_key_here

# Database (if applicable)
DATABASE_URL=your_database_url_here

# Other settings
NODE_ENV=development
PORT=3000
`
  )'), packageJson, { spaces: 2 });

  // Create pages
  await fs.ensureDir(path.join(projectPath, 'src', 'pages'));
  await fs.writeFile(
    path.join(projectPath, 'src', 'pages', 'index.tsx'),
    `import Head from 'next/head';

export default function Home() {
  return (
    <div>
      <Head>
        <title>${projectName}</title>
        <meta name="description" content="Generated by Cirron CLI" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <main>
        <h1>Welcome to ${projectName}</h1>
        <p>Your Next.js app is ready!</p>
      </main>
    </div>
  );
}
`
  );

  // Create next.config.js
  await fs.writeFile(
    path.join(projectPath, 'next.config.js'),
    `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  swcMinify: true,
};

module.exports = nextConfig;
`
  );

  // Create tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: 'es5',
      lib: ['dom', 'dom.iterable', 'esnext'],
      allowJs: true,
      skipLibCheck: true,
      strict: true,
      forceConsistentCasingInFileNames: true,
      noEmit: true,
      esModuleInterop: true,
      module: 'esnext',
      moduleResolution: 'node',
      resolveJsonModule: true,
      isolatedModules: true,
      jsx: 'preserve',
      incremental: true,
      plugins: [{ name: 'next' }],
      baseUrl: '.',
      paths: { '@/*': ['./src/*'] }
    },
    include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'],
    exclude: ['node_modules']
  };

  await fs.writeJSON(path.join(projectPath, 'tsconfig.json'), tsConfig, { spaces: 2 });
}

async function createReactFiles(projectPath: string, projectName: string): Promise<void> {
  const packageJson = {
    name: projectName,
    version: '0.1.0',
    private: true,
    scripts: {
      start: 'react-scripts start',
      build: 'react-scripts build',
      test: 'react-scripts test',
      eject: 'react-scripts eject'
    },
    dependencies: {
      react: '^18.0.0',
      'react-dom': '^18.0.0',
      'react-scripts': '^5.0.0'
    },
    devDependencies: {
      '@types/react': '^18.0.0',
      '@types/react-dom': '^18.0.0',
      typescript: '^5.0.0'
    }
  };

  await fs.writeJSON(path.join(projectPath, 'package.json'), packageJson, { spaces: 2 });

  // Create public directory
  await fs.ensureDir(path.join(projectPath, 'public'));
  await fs.writeFile(
    path.join(projectPath, 'public', 'index.html'),
    `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${projectName}</title>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`
  );

  // Create src directory
  await fs.ensureDir(path.join(projectPath, 'src'));
  await fs.writeFile(
    path.join(projectPath, 'src', 'App.tsx'),
    `import React from 'react';

function App() {
  return (
    <div>
      <h1>Welcome to ${projectName}</h1>
      <p>Your React app is ready!</p>
    </div>
  );
}

export default App;
`
  );

  await fs.writeFile(
    path.join(projectPath, 'src', 'index.tsx'),
    `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';

const root = ReactDOM.createRoot(
  document.getElementById('root') as HTMLElement
);

root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
`
  );
}

async function createVueFiles(projectPath: string, projectName: string): Promise<void> {
  // Implementation for Vue template
  const packageJson = {
    name: projectName,
    version: '0.1.0',
    scripts: {
      serve: 'vue-cli-service serve',
      build: 'vue-cli-service build',
      lint: 'vue-cli-service lint'
    },
    dependencies: {
      'core-js': '^3.0.0',
      vue: '^3.0.0'
    },
    devDependencies: {
      '@vue/cli-service': '^5.0.0',
      typescript: '^5.0.0'
    }
  };

  await fs.writeJSON(path.join(projectPath, 'package.json
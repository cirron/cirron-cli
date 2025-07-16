## Development Commands
In your cirron-cli directory

```bash
npm install        # Install dependencies
npm run build      # Build TypeScript
npm link           # Create global symlink

# Now you can use 'cirron' anywhere
cirron --version
cirron init test-project
```

To unlink later:

```bash
npm unlink -g cirron-cli
```

## Structure
```
cirron-cli/
├── .github/
│   └── workflows/
│       ├── ci.yml
│       └── release.yml
├── bin/
│   └── cirron
├── scripts/
│   ├── install.sh
│   └── release.js
├── src/
│   ├── commands/
│   │   ├── auth.ts
│   │   ├── build.ts
│   │   ├── deploy.ts
│   │   └── init.ts
│   ├── utils/
│   │   ├── api.ts
│   │   ├── config.ts
│   │   └── logger.ts
│   ├── types/
│   │   └── index.ts
│   └── index.ts
├── templates/
│   ├── nextjs/
│   └── react/
├── tests/
│   └── commands/
├── .gitignore
├── .npmignore
├── package.json
├── tsconfig.json
├── jest.config.js
├── README.md
└── LICENSE
```

## Build

Smart Project Detection:
- ML Projects (PyTorch, TensorFlow, sklearn) → Build Docker containers
- Traditional Projects → Use original build process

Container Build Process:
```bash
cirron build                           # Build container: localhost:5000/user/project:latest
cirron build --env staging             # Build: localhost:5000/user/project:staging-1.0.0  
cirron build --tag v1.2.3             # Build: localhost:5000/user/project:v1.2.3
cirron build --push                   # Build + push to registry
cirron build --clean                  # No-cache build
```

### Registry Configuration:
Uses environment variables for flexibility:
```bash
export CIRRON_REGISTRY=localhost:5000        # Default local registry
export CIRRON_ORG=mycompany                  # Your organization
# Image becomes: localhost:5000/mycompany/project:tag
```
Image Naming Convention:

Format: `registry/organization/project:tag`

Examples:
- `localhost:5000/john/my-pytorch-model:latest`
- `harbor.company.com/ml-team/sentiment-model:v1.0.0`


Build Output:
```bash
✅ Container build completed successfully! 🐳

📦 Build Results
Image: localhost:5000/john/my-model:development-1.0.0
Environment: development  
Size: 2.1 GB

Next steps:
  docker run -p 8000:8000 localhost:5000/john/my-model:development-1.0.0 - Test locally
  cirron build --push - Push to registry
  cirron deploy - Deploy to environment
Environment Variable Substitution:
Your cirron.json build commands can use:

${PROJECT_NAME} → project name
${VERSION} → project version
${IMAGE_NAME} → full image name
```

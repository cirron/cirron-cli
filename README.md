# Cirron CLI
Cirron's integrated CLI tool for machine learning engineers, data scientists, and anyone with an interest. The Cirron CLI streamlines the development, testing, and deployment of ML models with features like:

- **Project Templates**: Quick-start with PyTorch, TensorFlow, or scikit-learn, with more to come
- **Automated Testing**: Built-in test suite for ML environments, data pipelines, and model inference
- **Container Management**: Simplified Docker builds and deployments
- **Environment Validation**: Checks for Python, CUDA, and dependency compatibility
- **Development Tools**: Code quality checks, dependency management, and more

Install globally with:
```bash
npm install -g cirron-cli
```
or 
```bash
curl -fsSL https://cli.cirron.com | bash 
```

## Usage
1. Initialize New Projects Anywhere:
```bash
# From your home directory
cd ~
cirron init my-new-model --template pytorch

# From your projects folder
cd ~/projects
cirron init sentiment-analysis --template tensorflow

# From anywhere
cd /tmp
cirron init test-model --template sklearn
```
2. Work on Existing Projects:
```bash
# Navigate to any existing cirron project
cd ~/projects/my-pytorch-model

# Use cirron commands (it finds cirron.json automatically)
cirron test
cirron build
cirron deploy
```

3. How Cirron Finds Project Config:
The CLI looks for cirron.json in the current working directory:
```bash
my-pytorch-model/
├── cirron.json          ← CLI finds this
├── src/
├── Dockerfile
└── requirements.txt

# When you run:
cd my-pytorch-model
cirron build              # ✅ Works - finds cirron.json
```

```bash
# If you're in the wrong directory:
cd ~
cirron build              # ❌ Fails - no cirron.json found
```

4. Multi-Project Workflow:

```bash
# Work on multiple projects
cd ~/ml-projects/model-a
cirron build --tag v1.0.0

cd ~/ml-projects/model-b  
cirron test --model

cd ~/ml-projects/model-c
cirron deploy --env staging
```

🔧 Pro Tips:
Check if You're in a Cirron Project:
```bash
 # Shows project info if cirron.json exists
cirron status 
```

Global Commands (Work Anywhere):
```bash
cirron --version          # ✅ Works from anywhere
cirron --help             # ✅ Works from anywhere  
cirron auth login         # ✅ Works from anywhere
cirron config --list     # ✅ Works from anywhere
```

Project Commands (Need cirron.json):
```bash
cirron init               # ✅ Works anywhere (creates new project)
cirron build              # ❌ Needs cirron.json in current directory
cirron test               # ❌ Needs cirron.json in current directory
cirron deploy             # ❌ Needs cirron.json in current directory
```

🚀 Typical Multi-Project Setup:
```bash
~/ml-projects/
├── sentiment-model/
│   ├── cirron.json
│   └── src/
├── image-classifier/
│   ├── cirron.json  
│   └── src/
└── recommendation-engine/
    ├── cirron.json
    └── src/

# Work on any project:
cd ~/ml-projects/sentiment-model && cirron build
cd ~/ml-projects/image-classifier && cirron test
cd ~/ml-projects/recommendation-engine && cirron deploy
```


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
│   │   ├── compile.ts
│   │   ├── config.ts
│   │   ├── deploy.ts
│   │   ├── env.ts
│   │   ├── files
│   │   ├── init.ts
│   │   ├── logs.ts
│   │   ├── status.ts
│   │   └── test.ts
│   ├── utils/
│   │   ├── api.ts
│   │   ├── config.ts
│   │   └── logger.ts
│   ├── types/
│   │   └── index.ts
│   └── index.ts
├── .gitignore
├── .npmignore
├── package.json
├── tsconfig.json
├── jest.config.js
├── README.md
└── LICENSE
```

## Compile

ML model compilation with architecture optimization:

```bash
cirron compile                        # Compile with default architecture
cirron compile --arch cuda           # Compile for CUDA
cirron compile --arch gpu            # Compile for GPU (TensorFlow)
cirron compile --validate            # Run validation checks before compile
cirron compile --dry-run             # Simulate compilation without execution
cirron compile --index config.json   # Use custom configuration file
```

## Build

Smart Project Detection:
- ML Projects (PyTorch, TensorFlow, sklearn) → ML builds with architecture templates
- Traditional Projects → Standard build process

### Basic Build Commands
```bash
cirron build                           # Build container: localhost:5000/user/project:latest
cirron build --env staging             # Build: localhost:5000/user/project:staging-1.0.0  
cirron build --tag v1.2.3             # Build: localhost:5000/user/project:v1.2.3
cirron build --push                   # Build + push to registry
cirron build --clean                  # No-cache build
```

### Architecture Templates
Use pre-built templates for common ML patterns:
```bash
cirron build --arch transformer       # Build with transformer architecture
cirron build --arch xgboost          # Build with XGBoost model template
cirron build --arch resnet           # Build with ResNet architecture
cirron build --arch lstm             # Build with LSTM/RNN template
cirron build --arch autoencoder      # Build with encoder-decoder template
```

### Validation and Dry-Run
```bash
cirron build --validate              # Run comprehensive validation checks
cirron build --dry-run               # Simulate build without execution
cirron build --dry-run --validate    # Full validation + build simulation
cirron build --index manifest.json   # Build with custom manifest file
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
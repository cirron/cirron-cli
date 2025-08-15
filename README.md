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
cirron compile --interactive         # Step-by-step compilation confirmations
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
cirron build --interactive           # Step-by-step build confirmations
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
Container build completed successfully!

Build Results
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

## File Exclusion (.cirronignore)

Control which files are processed by Cirron commands using a `.cirronignore` file, similar to `.dockerignore`:

```bash
# Create .cirronignore in your project root
echo "*.log" > .cirronignore
echo "temp_*" >> .cirronignore
echo "__pycache__/" >> .cirronignore
```

### .cirronignore Syntax

```bash
# Comments start with #
# Exclude all log files
*.log

# Exclude temporary files
temp_*
*.tmp

# Exclude directories (trailing slash optional)
__pycache__/
node_modules

# Exclude directory contents
build/**

# Include exceptions (negation with !)
data/
!data/sample/
!data/test/

# Exclude large model files but keep configs
models/*.pth
models/*.pkl
!models/config.json
```

### Default Patterns

When you run `cirron init`, a default `.cirronignore` is created with common patterns:

```bash
# Version control
.git/
.svn/

# Large data files
data/raw/
data/processed/
*.csv
!data/sample/*.csv

# Model artifacts
models/*.pth
models/*.pkl
models/*.joblib

# Development files
.vscode/
.idea/
__pycache__/
*.pyc

# Temporary files
temp_*
*.tmp
*.log
```

### How .cirronignore Works

- **Build Command**: Automatically integrates patterns into `.dockerignore` during container builds
- **Test Command**: Filters files when scanning test data directories
- **File Operations**: Excludes files from processing in various Cirron operations
- **Pattern Matching**: Uses glob patterns with support for negation (`!`)

Example usage:
```bash
# These files will be ignored during build and test
echo "large-dataset.csv" >> .cirronignore
echo "debug.log" >> .cirronignore

# Run build - ignored files won't be included
cirron build

# Run tests - ignored files won't be processed  
cirron test --data
```

## Plan and Replay

Preview and plan complex operations before execution:

### Plan Commands
```bash
# Preview compilation with resource estimates
cirron plan compile                    # Plan compilation for default architecture
cirron plan compile --arch cuda        # Plan CUDA-specific compilation
cirron plan compile --validate         # Include validation checks in plan

# Preview container builds  
cirron plan build                      # Plan build with current configuration
cirron plan build --arch transformer   # Plan build with transformer template
cirron plan build --validate          # Include comprehensive validation

# Preview project linting
cirron plan lint                       # Plan lint checks for all categories
cirron plan lint --code                # Plan code quality checks only

# Preview testing strategy
cirron plan test                       # Plan test execution
cirron plan test --model               # Plan model testing only

# Interactive mode for all commands
cirron build --interactive            # Step-by-step build confirmations
cirron compile --interactive          # Interactive compilation with architecture selection
cirron test --interactive             # Smart test selection and error handling
cirron plan build --interactive       # Enhanced planning with save options
```

### Plan Management
```bash
# Save plans for later execution
cirron plan save --name "v1.0-build"   # Save current build plan
cirron plan save --file build-plan.json # Save to specific file

# Compare plans to detect changes
cirron plan compare                     # Compare with previous plan
cirron plan compare --baseline v1.0     # Compare with named baseline
```

### Replay Saved Plans
```bash
# Execute previously saved plans
cirron replay build-plan.json          # Execute saved plan file
cirron replay --plan v1.0-build        # Execute named plan
cirron replay --validate               # Validate plan before execution
```

**Use Cases:**
- **CI/CD Planning**: Preview deployment impacts before execution
- **Change Detection**: Compare current vs previous plans to understand modifications
- **Resource Planning**: Estimate requirements for large ML operations  
- **Team Collaboration**: Share plans for review before execution

## Lint

Comprehensive project health checking and code quality analysis:

### Basic Lint Commands
```bash
cirron lint                            # Run all lint categories
cirron lint --fix                      # Automatically fix issues where possible
cirron lint --json                     # Output structured JSON results
cirron lint --strict                   # Treat warnings as errors
```

### Category-Specific Linting
```bash
cirron lint --config                   # Check cirron.json and configurations
cirron lint --structure                # Validate project file structure
cirron lint --dependencies             # Analyze Python requirements conflicts
cirron lint --code                     # Run code quality checks
```

### Lint Output
The lint command provides:
- **Severity Levels**: Errors, warnings, and info messages
- **Fixable Indicators**: Shows which issues can be auto-resolved
- **File Locations**: Specific line numbers for code issues
- **Fix Suggestions**: Actionable recommendations for resolution
- **Category Grouping**: Organized by config, structure, dependencies, and code

Example output:
```bash
Configuration: All checks passed
Structure: 2 warnings found
- Missing model.py in src/ directory (fixable)
- No test data samples found in data/sample/
Dependencies: 1 error found  
- Conflicting versions: torch>=1.9.0 vs torchvision==0.10.0 (requires torch<1.9)
Code Quality: All checks passed

Summary: 1 error, 2 warnings, 0 info
Run with --fix to automatically resolve fixable issues
```

## Test

Comprehensive ML project testing with smart selection and interactive modes:

### Basic Test Commands
```bash
cirron test                            # Run default test suite (env, requirements, unit, model, data)
cirron test --interactive             # Smart test selection with presets and custom options
cirron test --strict                  # Fail fast on any errors (useful for CI)
cirron test --json                    # Output results in JSON format
```

### Individual Test Types
```bash
cirron test --env                     # Test Python, CUDA, and environment setup
cirron test --requirements           # Validate Python requirements and dependencies
cirron test --unit                   # Run pytest/unittest test suites
cirron test --model                  # Test model loading and instantiation
cirron test --data                   # Test data loading functionality
cirron test --inference              # Test model inference pipeline
cirron test --lint                   # Run code quality checks
cirron test --build                  # Test Docker container build
```

### Advanced Testing
```bash
cirron test --val -p data/validation  # Run model validation tests on specific data
cirron test --endpoint http://api.com # Test deployed endpoint performance
cirron test --pipeline                # End-to-end ML pipeline testing
cirron test --watch                   # Watch mode for continuous testing
```

### Interactive Test Selection
When using `--interactive` mode, you can choose from:
- **All steps**: Run complete test suite
- **Essential only (quick)**: Run core tests (env, requirements, model, data)
- **Custom selection**: Pick individual test types
- **None (skip all)**: Skip testing entirely

Example interactive flow:
```bash
cirron test --interactive
? How would you like to select steps?
  ❯ All steps
    Essential only (quick)
    Custom selection
    None (skip all)
```
# CLI Error Codes Documentation

The Cirron CLI now supports structured error codes that make it easier to script around and handle errors programmatically, especially in CI/CD environments.

## Strict Mode

Enable strict mode with the `--strict` flag on any command to get fail-fast behavior with specific exit codes:

```bash
# Enable strict mode for CI/CD
cirron compile --strict
cirron build --strict  
cirron test --strict
cirron lint --strict

# Non-strict mode (default) - allows degraded execution
cirron compile  # May continue with warnings
```

## Error Code Categories

### Success (0)
- **0**: `SUCCESS` - Operation completed successfully

### Script and Execution Errors (1-10)
- **1**: `SCRIPT_FAILED` - General script execution failure
- **2**: `PYTHON_SYNTAX_ERROR` - Python syntax error detected
- **3**: `PYTHON_IMPORT_ERROR` - Missing Python module/import error
- **4**: `TIMEOUT` - Operation timed out
- **5**: `COMMAND_NOT_FOUND` - Required command not found

### Hardware and System Errors (11-20)
- **11**: `CUDA_FAILURE` - CUDA-related operation failed
- **12**: `GPU_FAILURE` - GPU operation failed
- **13**: `SYSTEM_REQUIREMENTS_NOT_MET` - System requirements not met
- **14**: `INSUFFICIENT_RESOURCES` - Insufficient system resources

### ML-Specific Errors (21-30)
- **21**: `MODEL_CREATION_FAILED` - ML model creation failed
- **22**: `MODEL_LOADING_FAILED` - ML model loading failed
- **23**: `MODEL_VALIDATION_FAILED` - ML model validation failed
- **24**: `INFERENCE_FAILED` - Model inference failed
- **25**: `TRAINING_FAILED` - Model training failed

### Project and Configuration Errors (31-40)
- **31**: `PROJECT_NOT_FOUND` - Cirron project not found (no cirron.json)
- **32**: `INVALID_CONFIG` - Invalid project configuration
- **33**: `MISSING_DEPENDENCIES` - Missing required dependencies
- **34**: `BUILD_FAILED` - Build process failed
- **35**: `VALIDATION_FAILED` - Validation checks failed
- **36**: `COMPILE_FAILED` - Compilation failed

### Testing and Quality Errors (41-50)
- **41**: `UNIT_TESTS_FAILED` - Unit tests failed
- **42**: `LINT_FAILED` - Code linting failed
- **43**: `TYPE_CHECK_FAILED` - Type checking failed
- **44**: `CODE_QUALITY_FAILED` - Code quality checks failed

## Usage in CI/CD

### GitHub Actions Example
```yaml
- name: Compile ML Model
  run: cirron compile --strict --arch cuda
  # Will exit with specific code on failure

- name: Handle CUDA Errors
  if: failure()
  run: |
    if [ $? -eq 11 ]; then
      echo "CUDA error detected, falling back to CPU"
      cirron compile --strict --arch cpu
    fi
```

### Shell Scripting Example
```bash
#!/bin/bash

# Compile with strict mode
cirron compile --strict
exit_code=$?

case $exit_code in
  0)
    echo "Compilation successful"
    ;;
  2)
    echo "Python syntax error - check your model.py"
    exit 1
    ;;
  3)
    echo "Missing Python dependencies - run pip install"
    pip install -r requirements.txt
    cirron compile --strict  # Retry
    ;;
  11)
    echo "CUDA not available - falling back to CPU"
    cirron compile --strict --arch cpu
    ;;
  21)
    echo "Model creation failed - check model architecture"
    exit 1
    ;;
  *)
    echo "Unknown error (code: $exit_code)"
    exit $exit_code
    ;;
esac
```

## Timeout Support

The CLI includes comprehensive timeout support for preventing hanging operations:

```bash
# Default timeouts (30 seconds for most operations)
cirron compile --strict
cirron test --strict

# Operations automatically timeout and return exit code 4
# Useful for:
# - Hanging GPU kernel compilation
# - Dataset loading that goes wrong  
# - Network operations that stall
# - Training loops that get stuck
```

### Timeout Scenarios
- **Model Compilation**: GPU kernels that hang during compilation
- **Data Loading**: Large dataset loading that stalls
- **Training**: ML training loops that get stuck
- **Inference**: Model inference that hangs on GPU
- **Network Operations**: API calls or downloads that timeout

## Error Details

In strict mode, errors include:
- **Specific exit codes** for programmatic handling
- **Detailed error messages** with context
- **Actionable suggestions** for resolution
- **Parsed error information** (file locations, line numbers)
- **Retry logic** for transient failures (CUDA setup, etc.)
- **Timeout handling** for hanging operations

## Non-Strict vs Strict Mode

| Feature | Non-Strict Mode | Strict Mode |
|---------|----------------|-------------|
| **CUDA Errors** | Warning, continue with CPU | Exit code 11 |
| **Syntax Errors** | Warning, attempt to continue | Exit code 2 |
| **Import Errors** | Warning, degraded functionality | Exit code 3 |
| **Validation Failures** | Warning, continue build | Exit code 35 |
| **Model Loading Issues** | Warning, skip tests | Exit code 21 |
| **Timeouts** | Warning, operation cancelled | Exit code 4 |

## Getting Error Information

```bash
# Get detailed error information
cirron compile --strict --verbose

# JSON output for parsing
cirron lint --strict --json
```

This structured approach makes the Cirron CLI much more suitable for automated environments while preserving the flexible, developer-friendly defaults for interactive use.
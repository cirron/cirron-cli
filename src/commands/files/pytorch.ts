import yaml from 'js-yaml';
import { dedent } from '../../utils/dedent';
import {
  buildOnnxServeScript,
  buildSyntheticTabularServingConfig,
  writeProjectFiles,
} from './shared';

const PYTORCH_REQUIREMENTS = dedent(`
  torch>=2.5.0
  numpy>=2.1.0
  onnx>=1.16.0
  onnxscript>=0.1.0
  onnxruntime>=1.20.0
`);

const PYTORCH_REQUIREMENTS_TRAIN = dedent(`
  torch>=2.5.0
  numpy>=2.1.0
  tqdm>=4.66.0
  onnx>=1.16.0
  onnxscript>=0.1.0
  onnxruntime>=1.20.0
`);

function buildPyTorchTrainScript(modelType: string, withTrainingLoop: boolean): string {
  const isRegression = modelType === 'regression';
  const finalActivation = isRegression ? '' : ', nn.LogSoftmax(dim=1)';
  const lossFn = isRegression ? 'nn.MSELoss()' : 'nn.CrossEntropyLoss()';
  const targetDtype = isRegression ? 'torch.float32' : 'torch.long';
  const outputDim = isRegression ? '1' : '2';
  const yLine = isRegression
    ? 'weights = rng.normal(size=NUM_FEATURES).astype(np.float32)\n    y = (X @ weights + rng.normal(scale=0.1, size=n)).astype(np.float32)'
    : 'y = (X.sum(axis=1) > 0).astype(np.int64)';

  const trainBody = withTrainingLoop
    ? [
        '    num_epochs = 8',
        '    for epoch in range(num_epochs):',
        '        model.train()',
        '        running = 0.0',
        '        for xb, yb in tqdm(train_loader, desc=f"epoch {epoch + 1}/{num_epochs}"):',
        '            optimizer.zero_grad()',
        '            pred = model(xb)',
        '            target = yb.unsqueeze(1) if pred.shape == yb.unsqueeze(1).shape else yb',
        '            loss = loss_fn(pred, target)',
        '            loss.backward()',
        '            optimizer.step()',
        '            running += loss.item() * xb.size(0)',
        '        print(f"epoch {epoch + 1}: train_loss={running / len(train_loader.dataset):.4f}")',
      ].join('\n')
    : [
        '    for _ in range(3):',
        '        for xb, yb in train_loader:',
        '            optimizer.zero_grad()',
        '            pred = model(xb)',
        '            target = yb.unsqueeze(1) if pred.shape == yb.unsqueeze(1).shape else yb',
        '            loss = loss_fn(pred, target)',
        '            loss.backward()',
        '            optimizer.step()',
      ].join('\n');

  const tqdmImport = withTrainingLoop ? 'from tqdm import tqdm\n' : '';

  return [
    '"""Train a small PyTorch model and export it to ONNX for serving."""',
    'import os',
    'import numpy as np',
    'import torch',
    'import torch.nn as nn',
    'from torch.utils.data import DataLoader, TensorDataset',
    tqdmImport,
    'ARTIFACTS_DIR = os.path.join(os.path.dirname(__file__), "artifacts")',
    'NUM_FEATURES = 10',
    `OUTPUT_DIM = ${outputDim}`,
    '',
    '',
    'def make_synthetic_data(n: int = 1000, seed: int = 42):',
    '    rng = np.random.default_rng(seed)',
    '    X = rng.normal(size=(n, NUM_FEATURES)).astype(np.float32)',
    `    ${yLine}`,
    '    return X, y',
    '',
    '',
    'def build_model():',
    '    return nn.Sequential(',
    '        nn.Linear(NUM_FEATURES, 64),',
    '        nn.ReLU(),',
    '        nn.Dropout(0.2),',
    `        nn.Linear(64, OUTPUT_DIM)${finalActivation},`,
    '    )',
    '',
    '',
    'def train():',
    '    X, y = make_synthetic_data()',
    '    X_t = torch.from_numpy(X)',
    `    y_t = torch.tensor(y, dtype=${targetDtype})`,
    '    train_loader = DataLoader(TensorDataset(X_t, y_t), batch_size=32, shuffle=True)',
    '',
    '    model = build_model()',
    '    optimizer = torch.optim.Adam(model.parameters(), lr=1e-3)',
    `    loss_fn = ${lossFn}`,
    '',
    '    print("Training...")',
    trainBody,
    '',
    '    model.eval()',
    '    os.makedirs(ARTIFACTS_DIR, exist_ok=True)',
    '    onnx_path = os.path.join(ARTIFACTS_DIR, "model.onnx")',
    '    dummy = torch.randn(1, NUM_FEATURES)',
    '    torch.onnx.export(',
    '        model,',
    '        dummy,',
    '        onnx_path,',
    '        input_names=["input"],',
    '        output_names=["output"],',
    '        dynamic_axes={"input": {0: "batch"}, "output": {0: "batch"}},',
    '        opset_version=17,',
    '    )',
    '    print(f"ONNX model exported to {onnx_path}")',
    '',
    '',
    'if __name__ == "__main__":',
    '    train()',
    '',
  ].join('\n');
}

function buildCirronYaml(projectName: string, modelType: string, description: string): string {
  const cfg = {
    name: projectName,
    framework: 'pytorch',
    type: modelType,
    version: '1.0.0',
    description,
    servingConfig: buildSyntheticTabularServingConfig('onnx', modelType),
  };
  return yaml.dump(cfg, { indent: 2, lineWidth: 100, noRefs: true });
}

export async function createPyTorchFiles(
  projectPath: string,
  projectName: string,
  options: { modelType: string },
): Promise<void> {
  const description = `PyTorch ${options.modelType} scaffold from Cirron CLI. Trains a small classifier and exports to ONNX for serving.`;
  await writeProjectFiles(projectPath, {
    'cirron.yaml': buildCirronYaml(projectName, options.modelType, description),
    'requirements.txt': PYTORCH_REQUIREMENTS,
    'train.py': buildPyTorchTrainScript(options.modelType, false),
    'serve.py': buildOnnxServeScript(),
  });
}

export async function createPyTorchTrainingFiles(
  projectPath: string,
  projectName: string,
  options: { modelType: string },
): Promise<void> {
  const description = `PyTorch ${options.modelType} training scaffold from Cirron CLI. Multi-epoch training loop, exports to ONNX.`;
  await writeProjectFiles(projectPath, {
    'cirron.yaml': buildCirronYaml(projectName, options.modelType, description),
    'requirements.txt': PYTORCH_REQUIREMENTS_TRAIN,
    'train.py': buildPyTorchTrainScript(options.modelType, true),
    'serve.py': buildOnnxServeScript(),
  });
}

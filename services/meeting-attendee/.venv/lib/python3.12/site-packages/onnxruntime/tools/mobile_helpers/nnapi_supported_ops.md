<!--
Keep in sync with doco generated from /docs/execution-providers/NNAPI-ExecutionProvider.md on the gh_pages branch
-->
|Operator|Note|
|--------|------|
|ai.onnx:Abs||
|ai.onnx:Add||
|ai.onnx:AveragePool|Only 2D Pool is supported.|
|ai.onnx:BatchNormalization||
|ai.onnx:Cast||
|ai.onnx:Clip||
|ai.onnx:Concat||
|ai.onnx:Conv|Only 2D Conv is supported.<br/>Weights and bias should be constant.|
|ai.onnx:DepthToSpace|Only DCR mode DepthToSpace is supported.|
|ai.onnx:DequantizeLinear|All quantization scales and zero points should be constant.|
|ai.onnx:Div||
|ai.onnx:Elu||
|ai.onnx:Exp||
|ai.onnx:Flatten||
|ai.onnx:Floor||
|ai.onnx:Gather|Input indices should be constant if not int32 type.|
|ai.onnx:Gemm|If input B is not constant, transB should be 1.|
|ai.onnx:GlobalAveragePool|Only 2D Pool is supported.|
|ai.onnx:GlobalMaxPool|Only 2D Pool is supported.|
|ai.onnx:Identity||
|ai.onnx:LeakyRelu||
|ai.onnx:Log||
|ai.onnx:LRN||
|ai.onnx:MatMul||
|ai.onnx:MaxPool|Only 2D Pool is supported.|
|ai.onnx:Max||
|ai.onnx:Min||
|ai.onnx:Mul||
|ai.onnx:Neg||
|ai.onnx:Pad|Only constant mode Pad is supported.<br/>Input pads and constant_value should be constant.<br/>Input pads values should be non-negative.|
|ai.onnx:Pow||
|ai.onnx:PRelu||
|ai.onnx:QLinearConv|Only 2D Conv is supported.<br/>Weights and bias should be constant.<br/>All quantization scales and zero points should be constant.|
|ai.onnx:QLinearMatMul|All quantization scales and zero points should be constant.|
|ai.onnx:QuantizeLinear|All quantization scales and zero points should be constant.|
|ai.onnx:ReduceMean||
|ai.onnx:Relu||
|ai.onnx:Reshape||
|ai.onnx:Resize|Only 2D Resize is supported.|
|ai.onnx:Sigmoid||
|ai.onnx:Sin||
|ai.onnx:Slice||
|ai.onnx:Softmax||
|ai.onnx:Split|Number of splits must evenly divide split axis size. Input split should be constant if provided.|
|ai.onnx:Sqrt||
|ai.onnx:Squeeze|Input axes should be constant.|
|ai.onnx:Sub||
|ai.onnx:Tanh||
|ai.onnx:Transpose||
|ai.onnx:Unsqueeze|Input axes should be constant.|
|com.microsoft:QLinearAdd|All quantization scales and zero points should be constant.|
|com.microsoft:QLinearAveragePool|Only 2D Pool is supported.<br/>All quantization scales and zero points should be constant.|
|com.microsoft:QLinearSigmoid|All quantization scales and zero points should be constant.|

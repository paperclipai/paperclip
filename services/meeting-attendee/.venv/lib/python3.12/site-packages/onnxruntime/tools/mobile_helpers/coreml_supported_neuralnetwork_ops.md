<!--
Keep in sync with doco generated from /docs/execution-providers/CoreML-ExecutionProvider.md on the gh_pages branch
-->
|Operator|Note|
|--------|------|
|ai.onnx:Add||
|ai.onnx:ArgMax||
|ai.onnx:AveragePool|Only 2D Pool is supported.|
|ai.onnx:BatchNormalization||
|ai.onnx:Cast||
|ai.onnx:Clip||
|ai.onnx:Concat||
|ai.onnx:Conv|Only 1D/2D Conv is supported.<br/>Weights and bias should be constant.|
|ai.onnx:DepthToSpace|Only DCR mode DepthToSpace is supported.|
|ai.onnx:Div||
|ai.onnx:Flatten||
|ai.onnx:Gather|Input `indices` with scalar value is not supported.|
|ai.onnx:Gemm|Input B should be constant.|
|ai.onnx:GlobalAveragePool|Only 2D Pool is supported.|
|ai.onnx:GlobalMaxPool|Only 2D Pool is supported.|
|ai.onnx:LeakyRelu||
|ai.onnx:LRN||
|ai.onnx:MatMul|Input B should be constant.|
|ai.onnx:MaxPool|Only 2D Pool is supported.|
|ai.onnx:Mul||
|ai.onnx:Pad|Only constant mode and last two dim padding is supported.<br/>Input pads and constant_value should be constant.<br/>If provided, axes should be constant.|
|ai.onnx:Pow|Only supports cases when both inputs are fp32.|
|ai.onnx:PRelu|Input slope should be constant.<br/>Input slope should either have shape [C, 1, 1] or have 1 element.|
|ai.onnx:Reciprocal||
|ai.onnx.ReduceSum||
|ai.onnx:Relu||
|ai.onnx:Reshape||
|ai.onnx:Resize|4D input.<br/>`coordinate_transformation_mode` == `asymmetric`.<br/>`mode` == `linear` or `nearest`.<br/>`nearest_mode` == `floor`.<br/>`exclude_outside` == false<br/>`scales` or `sizes` must be constant.|
|ai.onnx:Shape|Attribute `start` with non-default value is not supported.<br/>Attribute `end` is not supported.|
|ai.onnx:Sigmoid||
|ai.onnx:Slice|Inputs `starts`, `ends`, `axes`, and `steps` should be constant. Empty slice is not supported.|
|ai.onnx:Softmax||
|ai.onnx:Split|If provided, `splits` must be constant.|
|ai.onnx:Squeeze||
|ai.onnx:Sqrt||
|ai.onnx:Sub||
|ai.onnx:Tanh||
|ai.onnx:Transpose||

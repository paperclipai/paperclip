<!--
Keep in sync with doco generated from /docs/execution-providers/CoreML-ExecutionProvider.md on the gh_pages branch
-->
|Operator|Note|
|--------|------|
|ai.onnx:Add||
|ai.onnx:Argmax||
|ai.onnx:AveragePool|Only 2D Pool is supported currently. 3D and 5D support can be added if needed.|
|ai.onnx:Cast||
|ai.onnx:Clip||
|ai.onnx:Concat||
|ai.onnx:Conv|Only 1D/2D Conv is supported.<br/>Bias if provided must be constant.|
|ai.onnx:ConvTranspose|Weight and bias must be constant.<br/>padding_type of SAME_UPPER/SAME_LOWER is not supported.<br/>kernel_shape must have default values.<br/>output_shape is not supported.<br/>output_padding must have default values.|
|ai.onnx:DepthToSpace|If 'mode' is 'CRD' the input must have a fixed shape.|
|ai.onnx:Div||
|ai.onnx:Elu||
|ai.onnx:Erf||
|ai.onnx:Exp||
|ai.onnx:Gemm|Input B must be constant.|
|ai.onnx:Gelu||
|ai.onnx:GlobalAveragePool|Only 2D Pool is supported currently. 3D and 5D support can be added if needed.|
|ai.onnx:GlobalMaxPool|Only 2D Pool is supported currently. 3D and 5D support can be added if needed.|
|ai.onnx:GridSample|4D input.<br/>'mode' of 'linear' or 'zeros'.<br/>(mode==linear && padding_mode==reflection && align_corners==0) is not supported.|
|ai.onnx:GroupNormalization||
|ai.onnx:InstanceNormalization||
|ai.onnx:LayerNormalization||
|ai.onnx:LeakyRelu||
|ai.onnx:MatMul|Only support for transA == 0, alpha == 1.0 and beta == 1.0 is currently implemented.|
|ai.onnx:MaxPool|Only 2D Pool is supported currently. 3D and 5D support can be added if needed.|
|ai.onnx:Max||
|ai.onnx:Mul||
|ai.onnx:Pow|Only supports cases when both inputs are fp32.|
|ai.onnx:PRelu||
|ai.onnx:Reciprocal|this ask for a `epislon` (default 1e-4) where onnx don't provide|
|ai.onnx:ReduceSum||
|ai.onnx:ReduceMean||
|ai.onnx:ReduceMax||
|ai.onnx:Relu||
|ai.onnx:Reshape||
|ai.onnx:Resize|See [resize_op_builder.cc](https://github.com/microsoft/onnxruntime/blob/main/onnxruntime/core/providers/coreml/builders/impl/resize_op_builder.cc) implementation. There are too many permutations to describe the valid combinations.|
|ai.onnx:Round||
|ai.onnx:Shape||
|ai.onnx:Slice|starts/ends/axes/steps must be constant initializers.|
|ai.onnx:Softplus||
|ai.onnx:Split|If provided, `splits` must be constant.|
|ai.onnx:Sub||
|ai.onnx:Sigmoid||
|ai.onnx:Softmax||
|ai.onnx:Sqrt||
|ai.onnx:Squeeze||
|ai.onnx:Tanh||
|ai.onnx:Transpose||
|ai.onnx:Unsqueeze||

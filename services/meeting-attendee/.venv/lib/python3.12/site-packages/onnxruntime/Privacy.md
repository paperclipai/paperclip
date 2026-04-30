# Privacy

## Data Collection
The software may collect information about you and your use of the software and send it to Microsoft. Microsoft may use this information to provide services and improve our products and services. You may turn off the telemetry as described in the repository. There are also some features in the software that may enable you and Microsoft to collect data from users of your applications. If you use these features, you must comply with applicable law, including providing appropriate notices to users of your applications together with a copy of Microsoft's privacy statement. Our privacy statement is located at https://go.microsoft.com/fwlink/?LinkID=824704. You can learn more about data collection and use in the help documentation and our privacy statement. Your use of the software operates as your consent to these practices.

***

### Private Builds
No data collection is performed when using your private builds built from source code.

### Official Builds
ONNX Runtime does not maintain any independent telemetry collection mechanisms outside of what is provided by the platforms it supports. However, where applicable, ONNX Runtime will take advantage of platform-supported telemetry systems to collect trace events with the goal of improving product quality.

Currently telemetry is only implemented for Windows builds and is turned **ON** by default in the official builds distributed in their respective package management repositories ([see here](../README.md#binaries)). This may be expanded to cover other platforms in the future. Data collection is implemented via 'Platform Telemetry' per vendor platform providers (see [telemetry.h](../onnxruntime/core/platform/telemetry.h)).

#### Technical Details
The Windows provider uses the [TraceLogging](https://docs.microsoft.com/en-us/windows/win32/tracelogging/trace-logging-about) API for its implementation. This enables ONNX Runtime trace events to be collected by the operating system, and based on user consent, this data may be periodically sent to Microsoft servers following GDPR and privacy regulations for anonymity and data access controls. 

Windows ML and onnxruntime C APIs allow Trace Logging to be turned on/off (see [API pages](../README.md#api-documentation) for details).
For information on how to enable and disable telemetry, see [C API: Telemetry](./C_API.md#telemetry). 
There are equivalent APIs in the C#, Python, and Java language bindings as well.

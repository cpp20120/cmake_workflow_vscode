using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Schema;
using System.Text.Json.Serialization.Metadata;
using CMakeWorkflow.Host.Protocol;
using StreamJsonRpc;

var catalog = new JsonObject();
foreach (var method in typeof(IHostRpc).GetMethods().OrderBy(method => method.Name, StringComparer.Ordinal))
{
    var name = method.GetCustomAttributes(typeof(JsonRpcMethodAttribute), false)
        .Cast<JsonRpcMethodAttribute>().Single().Name ?? throw new InvalidOperationException("RPC method has no wire name.");
    catalog[name] = new JsonObject
    {
        ["request"] = Schema(method.GetParameters()[0].ParameterType),
        ["result"] = Schema(method.ReturnType.GetGenericArguments()[0]),
    };
}
File.WriteAllText(args.Single(), catalog.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) + "\n");

static JsonNode Schema(Type type)
{
    JsonTypeInfo metadata = HostJson.Default.GetTypeInfo(type)
        ?? throw new InvalidOperationException($"Missing wire metadata for {type}.");
    return metadata.GetJsonSchemaAsNode(new JsonSchemaExporterOptions { TreatNullObliviousAsNonNullable = true });
}

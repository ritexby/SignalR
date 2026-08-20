using System.Text.Json;
using System.Text.Json.Serialization;

namespace SignatureKiosk.Services;

/// <summary>
/// The tags an external system may send, and which of them carry a fixed set of values.
/// One place, so the editor, the API documentation and the validation cannot drift apart: the
/// admin panel reads this list from the server instead of keeping its own copy.
/// </summary>
public static class FieldSchema
{
    /// <summary>Tags that are true or false and nothing else. Used to show or hide content.</summary>
    public static readonly IReadOnlyList<string> BooleanFields = new[] { "cross-border", "urine", "UG" };

    /// <summary>Tags that only ever carry one of a fixed set of values.</summary>
    public static readonly IReadOnlyDictionary<string, string[]> Options =
        new Dictionary<string, string[]>(StringComparer.OrdinalIgnoreCase)
        {
            ["Пол"] = new[] { "M", "F" },
            ["cross-border"] = new[] { "true", "false" },
            ["urine"] = new[] { "true", "false" },
            ["UG"] = new[] { "true", "false" }
        };

    public static bool IsBoolean(string field) =>
        BooleanFields.Any(f => string.Equals(f, field, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Check the values an integration sent. A boolean tag is exactly "true" or "false"; anything
    /// else is refused by name, because a value that merely fails to match would silently hide a
    /// block and there would be nothing on screen to explain why.
    /// </summary>
    public static string? Validate(IReadOnlyDictionary<string, string>? fields)
    {
        if (fields is null) return null;
        foreach (var kv in fields)
        {
            if (!IsBoolean(kv.Key)) continue;
            var v = (kv.Value ?? "").Trim();
            if (v.Length == 0) continue;      // not sent is not the same as a wrong value
            if (!string.Equals(v, "true", StringComparison.OrdinalIgnoreCase) &&
                !string.Equals(v, "false", StringComparison.OrdinalIgnoreCase))
                return "Тег «" + kv.Key + "» принимает только true или false, получено: " + v;
        }
        return null;
    }

    /// <summary>
    /// Bring a value to the canonical form, so a condition written as true matches a tag sent as
    /// True. Non-boolean tags are left exactly as they came.
    /// </summary>
    public static string Canonical(string field, string? value)
    {
        var v = (value ?? "").Trim();
        if (!IsBoolean(field) || v.Length == 0) return v;
        return string.Equals(v, "true", StringComparison.OrdinalIgnoreCase) ? "true"
             : string.Equals(v, "false", StringComparison.OrdinalIgnoreCase) ? "false"
             // Documents written before this tag became a boolean used да / нет.
             : string.Equals(v, "да", StringComparison.OrdinalIgnoreCase) ? "true"
             : string.Equals(v, "нет", StringComparison.OrdinalIgnoreCase) ? "false"
             : v;
    }
}

/// <summary>
/// Accepts a JSON object whose values may be strings, booleans or numbers, and gives back strings.
///
/// Without this, an integration written the obvious way (new { urine = true }) sends a real JSON
/// boolean, and the whole request is rejected before any handler sees it: the document does not
/// appear on the tablet and the caller has nothing to go on. Values are stored as strings because
/// that is what a template substitutes and what a condition compares.
/// </summary>
public class LenientStringDictionaryConverter : JsonConverter<Dictionary<string, string>>
{
    public override Dictionary<string, string>? Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        if (reader.TokenType == JsonTokenType.Null) return null;
        if (reader.TokenType != JsonTokenType.StartObject) throw new JsonException("expected an object of fields");

        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        while (reader.Read())
        {
            if (reader.TokenType == JsonTokenType.EndObject) return result;
            if (reader.TokenType != JsonTokenType.PropertyName) throw new JsonException("expected a field name");
            var key = reader.GetString() ?? "";
            reader.Read();
            result[key] = reader.TokenType switch
            {
                JsonTokenType.String => reader.GetString() ?? "",
                JsonTokenType.True => "true",
                JsonTokenType.False => "false",
                JsonTokenType.Number => ReadNumber(ref reader),
                JsonTokenType.Null => "",
                // An object or an array is not a value a template can substitute; skipping it
                // keeps the rest of the request usable instead of failing all of it.
                JsonTokenType.StartObject or JsonTokenType.StartArray => SkipToString(ref reader),
                _ => ""
            };
        }
        throw new JsonException("unterminated object of fields");
    }

    private static string ReadNumber(ref Utf8JsonReader reader) =>
        reader.TryGetInt64(out var l) ? l.ToString(System.Globalization.CultureInfo.InvariantCulture)
                                      : reader.GetDouble().ToString(System.Globalization.CultureInfo.InvariantCulture);

    private static string SkipToString(ref Utf8JsonReader reader)
    {
        reader.Skip();
        return "";
    }

    public override void Write(Utf8JsonWriter writer, Dictionary<string, string> value, JsonSerializerOptions options)
    {
        writer.WriteStartObject();
        foreach (var kv in value) writer.WriteString(kv.Key, kv.Value ?? "");
        writer.WriteEndObject();
    }
}

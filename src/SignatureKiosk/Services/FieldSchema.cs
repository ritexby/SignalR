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

    /// <summary>
    /// Как показывать значение человеку. На проводе пол остаётся M и F: так его шлёт внешняя
    /// система и так записаны уже существующие условия. В интерфейсе показываются Ж и М,
    /// потому что оператор думает по-русски, а латинские M и F он читает как «мужской» и
    /// «женский» не сразу.
    /// </summary>
    public static readonly IReadOnlyDictionary<string, Dictionary<string, string>> ValueLabels =
        new Dictionary<string, Dictionary<string, string>>(StringComparer.OrdinalIgnoreCase)
        {
            ["Пол"] = new(StringComparer.OrdinalIgnoreCase) { ["M"] = "М (мужской)", ["F"] = "Ж (женский)" }
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
        if (v.Length == 0) return v;

        // Пол: принимаем и латиницу, и кириллицу. Русские Ж и М пишут и в документах, и в
        // интеграциях, а латинская M и русская М выглядят одинаково, так что различать их
        // на глаз невозможно и требовать одного написания значит собирать ошибки на ровном месте.
        if (string.Equals(field, "Пол", StringComparison.OrdinalIgnoreCase))
            return v switch
            {
                "M" or "m" or "М" or "м" or "муж" or "Муж" => "M",
                "F" or "f" or "Ж" or "ж" or "жен" or "Жен" => "F",
                _ => v
            };

        if (!IsBoolean(field)) return v;
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

/// <summary>
/// Принимает строковое поле, присланное числом, и отдаёт его строкой.
///
/// Зачем. Коды рабочих мест у владельца выглядят как числа: 1232, 3244, 54545. Интегратор пишет
/// их в JSON естественным образом, числом, и до этой уступки весь запрос отвергался платформой
/// ещё до обработчика. Ответ приходил такой: 400, длина тела ноль, ни заголовка Content-Type, ни
/// единого слова, и ни следа в журналах. Разобраться в этом снаружи нельзя ничем, кроме догадки.
/// Тот же код строкой проходил.
///
/// Уступка ровно одна: число становится своим же написанием. Настоящие числа в JSON остаются
/// числами, потому что они объявлены числовыми полями и сюда не попадают. Объект и массив на
/// месте строки по-прежнему отвергаются: это не описка в написании, а другая мысль, и принять её
/// молча значило бы потерять то, что прислали.
///
/// Это продолжение решения, которое в продукте уже принято для значений тегов
/// (LenientStringDictionaryConverter): вид написания на проводе не должен решать, доедет ли
/// документ до клиента.
/// </summary>
public class LenientStringConverter : JsonConverter<string>
{
    public override string? Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options) =>
        reader.TokenType switch
        {
            JsonTokenType.String => reader.GetString(),
            JsonTokenType.Null => null,
            JsonTokenType.Number => reader.TryGetInt64(out var l)
                ? l.ToString(System.Globalization.CultureInfo.InvariantCulture)
                : reader.GetDouble().ToString(System.Globalization.CultureInfo.InvariantCulture),
            JsonTokenType.True => "true",
            JsonTokenType.False => "false",
            _ => throw new JsonException("ожидалась строка")
        };

    public override void Write(Utf8JsonWriter writer, string value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value);
}

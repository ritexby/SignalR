namespace SignatureKiosk.Models;

// ---------- Kiosk / slideshow state ----------

/// <summary>Per-device (or default) screen state.</summary>
public class KioskState
{
    public string Mode { get; set; } = "slides"; // "slides" | "document"
    public List<string> PlaylistImageIds { get; set; } = new();
    public int IntervalSec { get; set; } = 6;
    public Dictionary<string, string> Fields { get; set; } = new();       // per-signer values for {{tags}}
    public List<DocCheckbox> DynamicCheckboxes { get; set; } = new();     // per-signer checkboxes from the API
    // Состояние именованных элементов, присланное внешней системой: отметки чекбоксов по ключу и
    // выбранный вариант в каждой группе. Хранится вместе с остальным состоянием планшета, чтобы
    // после переподключения он получил ровно то же самое.
    public Dictionary<string, bool> CheckboxStates { get; set; } = new();
    public Dictionary<string, string> GroupSelections { get; set; } = new();
    public DateTime? DocumentSetUtc { get; set; }                          // when the document was put on this device

    public KioskState Clone() => new()
    {
        Mode = Mode,
        PlaylistImageIds = new List<string>(PlaylistImageIds),
        IntervalSec = IntervalSec,
        Fields = new Dictionary<string, string>(Fields),
        DynamicCheckboxes = DynamicCheckboxes.Select(c => new DocCheckbox { Key = c.Key, Label = c.Label, Required = c.Required, Checked = c.Checked }).ToList(),
        CheckboxStates = new Dictionary<string, bool>(CheckboxStates),
        GroupSelections = new Dictionary<string, string>(GroupSelections),
        DocumentSetUtc = DocumentSetUtc
    };
}

/// <summary>Persisted collection of states: one shared default plus per-device overrides.</summary>
public class StateStore
{
    public KioskState Default { get; set; } = new();
    public Dictionary<string, KioskState> Devices { get; set; } = new();
}

// ---------- Devices, groups, workstations, enrollment ----------

/// <summary>An enrolled tablet. Authenticated by a per-device secret (hash stored here).</summary>
public class Device
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
    public string SecretHash { get; set; } = "";              // SHA-256 hex of the device secret
    public List<string> GroupIds { get; set; } = new();
    public string? WorkstationId { get; set; }
    public DateTime EnrolledUtc { get; set; }
    public DateTime LastSeenUtc { get; set; }
    public string? LastIp { get; set; }                       // client IP seen at the last connection
    // Address of the tablet's own FreeKiosk REST API. Usually the same as LastIp, but it must be
    // set by hand when the tablet reaches the server through a router, because then LastIp is the
    // router's address and not the tablet's.
    public string? ControlIp { get; set; }
    public int? ControlPort { get; set; }                     // overrides the fleet-wide port
    public string Status { get; set; } = "active";            // "active" | "revoked"
}

public class DeviceGroup
{
    public string Id { get; set; } = "";
    public string Name { get; set; } = "";
}

public class Workstation
{
    public string Id { get; set; } = "";
    public string ExternalId { get; set; } = "";              // key for the customer's external system
    public string Name { get; set; } = "";
    public string Location { get; set; } = "";
}

/// <summary>A one-time enrollment code that a tablet redeems for a device token.</summary>
public class Enrollment
{
    public string Code { get; set; } = "";
    public string? Name { get; set; }
    public string? WorkstationId { get; set; }
    public List<string> GroupIds { get; set; } = new();
    public DateTime CreatedUtc { get; set; }
    public DateTime ExpiresUtc { get; set; }
    public string? UsedByDeviceId { get; set; }               // null until redeemed
}

/// <summary>An API key for the external integration surface (/api/ext).</summary>
public class ApiKey
{
    public string Id { get; set; } = "";
    public string KeyHash { get; set; } = "";                 // SHA-256 hex of the key
    public string Label { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
}

// ---------- Images ----------

public class ImageInfo
{
    public string Id { get; set; } = "";
    public string FileName { get; set; } = "";
    public string OriginalName { get; set; } = "";
    public DateTime UploadedUtc { get; set; }
}

// ---------- Signing document ----------

public class DocCheckbox
{
    // Optional name the external system uses to address this exact checkbox. Checkbox names live
    // in their own namespace, separate from the {{tags}}: one name must never mean two things.
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
    public bool Required { get; set; } = true;
    public bool Checked { get; set; } = false; // initial state (used by API-supplied checkboxes)
    // Shown only while its condition holds. A condition on another checkbox is evaluated on the
    // tablet as the signer ticks; a condition on a tag is evaluated on the server, as before.
    public VisibleWhen? VisibleWhen { get; set; }
    // Место элемента внутри страницы. Блоки текста, чекбоксы и группы стоят в одном общем порядке,
    // поэтому номер сквозной для всех трёх видов. -1 означает "не задан": так выглядят документы,
    // сохранённые до появления свободного порядка, и им номера проставляются при сохранении.
    public int Ord { get; set; } = -1;
}

/// <summary>One option inside a group. Its key is what the API sends to select it.</summary>
public class DocGroupOption
{
    public string Key { get; set; } = "";
    public string Label { get; set; } = "";
}

/// <summary>
/// A set of options where at most one is chosen: "разрешаю / запрещаю", and choosing neither is a
/// third, valid state. Drawn as checkboxes rather than radio buttons on purpose, so tapping the
/// chosen one clears it and the signer can get back to having chosen nothing.
/// </summary>
public class DocGroup
{
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    public List<DocGroupOption> Options { get; set; } = new();
    public bool Required { get; set; } = false;   // true: nothing chosen blocks the signer
    public string? Selected { get; set; }         // option key, or null for nothing chosen
    public VisibleWhen? VisibleWhen { get; set; }
    // Место элемента внутри страницы. Блоки текста, чекбоксы и группы стоят в одном общем порядке,
    // поэтому номер сквозной для всех трёх видов. -1 означает "не задан": так выглядят документы,
    // сохранённые до появления свободного порядка, и им номера проставляются при сохранении.
    public int Ord { get; set; } = -1;
}

/// <summary>A styled piece of text. Formatting is a curated set so it renders identically on the
/// tablet and in the PDF: bold, italic, a size keyword ("n"/"l"/"h") and an optional hex colour.</summary>
public class TextRun
{
    public string Text { get; set; } = "";
    public bool Bold { get; set; }
    public bool Italic { get; set; }
    public string? Color { get; set; }   // "#rrggbb" (from the editor palette); null = default text colour
    public string? Size { get; set; }    // "n" (normal) | "l" (large) | "h" (huge); null/other = normal
}

/// <summary>A condition on an API field, used to show or hide a block or a whole page.
/// op: eq | ne | empty | notempty | in. For "in", Value is a comma-separated list.</summary>
public class VisibleWhen
{
    public string Field { get; set; } = "";
    public string Op { get; set; } = "eq";
    public string Value { get; set; } = "";
}

/// <summary>A block inside a page: either rich text (Runs) or an image (ImageUrl). Shown only when
/// its condition (if any) matches.</summary>
public class DocBlock
{
    public List<TextRun> Runs { get; set; } = new();
    public string? ImageUrl { get; set; }        // "/media/{file}" when this block is an image
    public int ImageWidth { get; set; } = 100;   // image width as a percent of the content width (10..100)
    public VisibleWhen? VisibleWhen { get; set; }
    // Место элемента внутри страницы. Блоки текста, чекбоксы и группы стоят в одном общем порядке,
    // поэтому номер сквозной для всех трёх видов. -1 означает "не задан": так выглядят документы,
    // сохранённые до появления свободного порядка, и им номера проставляются при сохранении.
    public int Ord { get; set; } = -1;
}

public class DocPage
{
    public string Heading { get; set; } = "";                  // legacy plain heading (fallback)
    public List<TextRun> HeadingRuns { get; set; } = new();    // rich heading
    public string Body { get; set; } = "";                     // legacy plain body (fallback)
    public List<DocBlock> Blocks { get; set; } = new();        // rich, optionally-conditional content
    public VisibleWhen? VisibleWhen { get; set; }              // page-level condition
    public List<DocCheckbox> Checkboxes { get; set; } = new();
    public List<DocGroup> Groups { get; set; } = new();
    public bool IncludeDynamic { get; set; } = false; // anchor: API-supplied checkboxes render here
}

public class DocumentConfig
{
    public string Title { get; set; } = "Документ";
    public List<DocPage> Pages { get; set; } = new();
    public string SignPrompt { get; set; } = "Пожалуйста, поставьте вашу подпись в поле ниже";
    // Custom content on the signature screen. SignBlocks sits above the signature field and
    // SignBlocksBelow under it, so a stamp, a note or company details can go on either side.
    public List<DocBlock> SignBlocks { get; set; } = new();
    public List<DocBlock> SignBlocksBelow { get; set; } = new();
    public string ThankYouText { get; set; } = "Спасибо! Ваша подпись принята.";
    public int IdleReturnSec { get; set; } = 180; // auto-return to ads after this idle time (0 = off)
}

/// <summary>
/// Settings for talking to the FreeKiosk app running on the tablets (its local REST API).
/// The server must be able to reach the tablet directly on this port, so this only works when the
/// tablets are on the same network as the server (or reachable over a VPN).
/// </summary>
public class KioskControlSettings
{
    public bool Enabled { get; set; } = false;      // off until the operator configures the key
    public int Port { get; set; } = 8080;           // FreeKiosk REST API default
    public string ApiKey { get; set; } = "";        // sent as X-Api-Key
    public int TimeoutSec { get; set; } = 5;
    public bool AutoHeal { get; set; } = false;     // try to revive a tablet that dropped off air
    public int AutoHealAfterMinutes { get; set; } = 5;
    public int BatteryWarnPercent { get; set; } = 20;
    public int StorageWarnPercent { get; set; } = 10;   // free space below this raises an alert
}

/// <summary>Last known health of a tablet, read from its FreeKiosk API.</summary>
public class KioskHealth
{
    public DateTime CheckedUtc { get; set; }
    public bool Reachable { get; set; }
    public string? Error { get; set; }
    public int? BatteryPercent { get; set; }
    public bool? Charging { get; set; }
    public int? WifiSignalPercent { get; set; }
    public string? WifiSsid { get; set; }
    public int? StorageFreePercent { get; set; }
    public int? MemoryFreePercent { get; set; }
    public int? BrightnessPercent { get; set; }
    public bool? ScreenOn { get; set; }
    public bool? DeviceOwner { get; set; }
    public string? AppVersion { get; set; }
    public string? AndroidVersion { get; set; }
    public string? Model { get; set; }
}

/// <summary>An operational alert the operator must react to (a tablet went off air, errors piling up).</summary>
public class Alert
{
    public string Id { get; set; } = "";          // stable key, e.g. "offline:dev-123" - one alert per cause
    public string Kind { get; set; } = "";        // offline | errors | test
    public string Severity { get; set; } = "warn";// warn | error
    public string Title { get; set; } = "";
    public string Detail { get; set; } = "";
    public DateTime SinceUtc { get; set; }        // when the condition started
    public DateTime UpdatedUtc { get; set; }
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
    public bool Acknowledged { get; set; }        // the operator has seen it; stays until it clears
}

/// <summary>Operator-configurable alerting thresholds.</summary>
public class AlertSettings
{
    public bool Enabled { get; set; } = true;
    public int OfflineMinutes { get; set; } = 10;      // alert when a tablet has been off air this long
    public int ErrorCount { get; set; } = 5;           // alert when this many errors happen...
    public int ErrorWindowMinutes { get; set; } = 10;  // ...within this window
}

/// <summary>One operational log entry shown on the admin "Логи" tab.</summary>
public class LogEntry
{
    public long Id { get; set; }
    public DateTime Utc { get; set; }
    public string Level { get; set; } = "error";   // error | warn | info
    public string Source { get; set; } = "";       // server component or "tablet"
    public string Message { get; set; } = "";
    public string? Detail { get; set; }            // stack trace / extra context
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
}

public record ClientLogDto(string? Level, string? Message, string? Detail);

/// <summary>A barcode / QR code scanned on a tablet.</summary>
public class ScanRecord
{
    public string Id { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    public string Code { get; set; } = "";        // the decoded payload
    public string Format { get; set; } = "";      // QR_CODE, EAN_13, EAN_8, CODE_128, ...
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
    public string? WorkstationId { get; set; }
    public string? WorkstationName { get; set; }
}

public class ScanSubmission
{
    public string Code { get; set; } = "";
    public string Format { get; set; } = "";
}

/// <summary>Export/import envelope for the document template, so a backup file can be identified
/// and validated before it replaces the live template.</summary>
public class DocumentBackup
{
    public const string KindValue = "helix-signtablet-document";
    public string Kind { get; set; } = KindValue;
    public int Version { get; set; } = 1;
    public DateTime ExportedUtc { get; set; }
    public DocumentConfig? Document { get; set; }
}

// ---------- Signature submission / record ----------

public class SubmittedItem
{
    public string Key { get; set; } = "";     // empty for a checkbox the operator did not name
    public string Label { get; set; } = "";
    public bool Checked { get; set; }
}

/// <summary>What the signer chose in a group: the option key, or empty for nothing chosen.</summary>
public class SubmittedGroup
{
    public string Key { get; set; } = "";
    public string Title { get; set; } = "";
    public string Selected { get; set; } = "";
    public string SelectedLabel { get; set; } = "";
    public List<DocGroupOption> Options { get; set; } = new();
}

public class SignatureSubmission
{
    public List<SubmittedItem> Items { get; set; } = new();
    public List<SubmittedGroup> Groups { get; set; } = new();
    public string Signature { get; set; } = ""; // data URL (image/png)
    // Identifies one signing session. If the response is lost and the tablet retries, the server
    // returns the record it already stored instead of creating a second, data-less duplicate.
    public string? SubmissionId { get; set; }
}

public class SignatureRecord
{
    public string Id { get; set; } = "";
    public DateTime CreatedUtc { get; set; }
    public string DocumentTitle { get; set; } = "";
    public string? DeviceId { get; set; }
    public string? DeviceName { get; set; }
    public string? WorkstationId { get; set; }
    public string? WorkstationName { get; set; }
    public List<SubmittedItem> Items { get; set; } = new();
    public List<SubmittedGroup> Groups { get; set; } = new();
    public Dictionary<string, string>? Fields { get; set; } // signer data used to fill {{tags}}
    public string? SubmissionId { get; set; }               // dedupes a retried submit
}

// ---------- Realtime payloads (server -> kiosk) ----------

public class SlidesPayload
{
    public List<string> Images { get; set; } = new(); // resolved URLs
    public int IntervalSec { get; set; } = 6;
}

public class CurrentCommand
{
    public string Mode { get; set; } = "slides"; // "slides" | "document"
    public SlidesPayload? Slides { get; set; }
    public DocumentConfig? Document { get; set; }
}

// ---------- API DTOs ----------

public record LoginDto(string? Password);
public record PlaylistSaveDto(string? Target, List<string>? ImageIds, int IntervalSec);
public record TargetDto(string? Target);
public record ShowDocumentDto(string? Target, Dictionary<string, string>? Fields, List<DocCheckbox>? Checkboxes, List<GroupSelectionDto>? Groups);

public record EnrollRequest(string? Code);
public record CreateEnrollmentDto(string? Name, string? WorkstationId, List<string>? GroupIds, int? TtlMinutes);
public record DeviceUpdateDto(string? Name, List<string>? GroupIds, string? WorkstationId);
public record GroupDto(string? Name);
public record WorkstationDto(string? ExternalId, string? Name, string? Location);
public record ApiKeyDto(string? Label);

public record ExtEnrollmentDto(string? WorkstationExternalId, string? Name);
public record ExtWorkstationAssignDto(string? ExternalId);
public record ExtShowDocumentDto(string? DeviceId, string? WorkstationExternalId, Dictionary<string, string>? Fields, List<DocCheckbox>? Checkboxes, List<GroupSelectionDto>? Groups);
public record ExtScanRequestDto(string? DeviceId, string? WorkstationExternalId, int? TimeoutSec);
public record AckDto(string? Id);
/// <summary>Выбор варианта в группе, присланный внешней системой.</summary>
public record GroupSelectionDto(string? Key, string? Selected, string? Title);

public record ControlAddressDto(string? Ip, int? Port);
/// <summary>What the admin panel sends when saving tablet control settings. The API key is
/// write-only: blank keeps the stored key, and removing it is an explicit request.</summary>
public record KioskControlSettingsDto(bool Enabled, int Port, string? ApiKey, bool ClearApiKey,
    int TimeoutSec, bool AutoHeal, int AutoHealAfterMinutes, int BatteryWarnPercent, int StorageWarnPercent);
public record ValueDto(int? Value);
public record TextDto(string? Text);
public record PreviewDto(DocumentConfig? Document, Dictionary<string, string>? Fields, List<DocCheckbox>? Checkboxes, List<GroupSelectionDto>? Groups);

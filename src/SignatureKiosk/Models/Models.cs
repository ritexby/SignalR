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

    public KioskState Clone() => new()
    {
        Mode = Mode,
        PlaylistImageIds = new List<string>(PlaylistImageIds),
        IntervalSec = IntervalSec,
        Fields = new Dictionary<string, string>(Fields),
        DynamicCheckboxes = DynamicCheckboxes.Select(c => new DocCheckbox { Label = c.Label, Required = c.Required, Checked = c.Checked }).ToList()
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
    public string Label { get; set; } = "";
    public bool Required { get; set; } = true;
    public bool Checked { get; set; } = false; // initial state (used by API-supplied checkboxes)
}

public class DocPage
{
    public string Heading { get; set; } = "";
    public string Body { get; set; } = "";
    public List<DocCheckbox> Checkboxes { get; set; } = new();
    public bool IncludeDynamic { get; set; } = false; // anchor: API-supplied checkboxes render here
}

public class DocumentConfig
{
    public string Title { get; set; } = "Документ";
    public List<DocPage> Pages { get; set; } = new();
    public string SignPrompt { get; set; } = "Пожалуйста, поставьте вашу подпись в поле ниже";
    public string ThankYouText { get; set; } = "Спасибо! Ваша подпись принята.";
    public int IdleReturnSec { get; set; } = 180; // auto-return to ads after this idle time (0 = off)
}

// ---------- Signature submission / record ----------

public class SubmittedItem
{
    public string Label { get; set; } = "";
    public bool Checked { get; set; }
}

public class SignatureSubmission
{
    public List<SubmittedItem> Items { get; set; } = new();
    public string Signature { get; set; } = ""; // data URL (image/png)
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
    public Dictionary<string, string>? Fields { get; set; } // signer data used to fill {{tags}}
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
public record ShowDocumentDto(string? Target, Dictionary<string, string>? Fields, List<DocCheckbox>? Checkboxes);

public record EnrollRequest(string? Code);
public record CreateEnrollmentDto(string? Name, string? WorkstationId, List<string>? GroupIds, int? TtlMinutes);
public record DeviceUpdateDto(string? Name, List<string>? GroupIds, string? WorkstationId);
public record GroupDto(string? Name);
public record WorkstationDto(string? ExternalId, string? Name, string? Location);
public record ApiKeyDto(string? Label);

public record ExtEnrollmentDto(string? WorkstationExternalId, string? Name);
public record ExtWorkstationAssignDto(string? ExternalId);
public record ExtShowDocumentDto(string? DeviceId, string? WorkstationExternalId, Dictionary<string, string>? Fields, List<DocCheckbox>? Checkboxes);

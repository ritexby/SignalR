namespace SignatureKiosk.Services;

/// <summary>
/// Действия, которые расписание умеет выполнять над планшетами. Список в одном месте, чтобы
/// сервер, интерфейс и проверка не могли разойтись: имена приходят с формы и должны совпадать
/// с тем, что умеет исполнитель.
/// </summary>
public static class ScheduleActions
{
    /// <summary>Действие: путь в FreeKiosk API планшета (или null для серверного действия).</summary>
    public sealed record Action(string Key, string Title, string? Path, bool CatchUp, bool NeedsValue = false, bool NeedsText = false);

    /// <summary>
    /// CatchUp = можно выполнить с опозданием, если сервис был выключен в назначенный момент.
    /// Включение экрана утром догонять надо: иначе сотрудники приходят к тёмным планшетам.
    /// Перезагрузку и перезапуск догонять нельзя: опоздавшая на полчаса команда перезагрузит
    /// парк посреди рабочего дня, а это хуже, чем не выполнить её вовсе.
    /// </summary>
    public static readonly IReadOnlyList<Action> All = new[]
    {
        new Action("screen-on", "Включить экран", "/api/screen/on", CatchUp: true),
        new Action("screen-off", "Выключить экран", "/api/screen/off", CatchUp: true),
        new Action("wake", "Разбудить планшет", "/api/wake", CatchUp: true),
        new Action("brightness", "Яркость экрана", "/api/brightness", CatchUp: true, NeedsValue: true),
        new Action("volume", "Громкость", "/api/volume", CatchUp: true, NeedsValue: true),
        new Action("return-slides", "Вернуть рекламу", null, CatchUp: true),
        new Action("reload", "Обновить страницу", "/api/reload", CatchUp: false),
        new Action("restart-app", "Перезапустить приложение", "/api/restart-ui", CatchUp: false),
        new Action("clear-cache", "Очистить кэш", "/api/clearCache", CatchUp: false),
        new Action("reboot", "Перезагрузить планшет", "/api/reboot", CatchUp: false),
        new Action("beep", "Звуковой сигнал", "/api/audio/beep", CatchUp: false),
        new Action("toast", "Показать сообщение", "/api/toast", CatchUp: false, NeedsText: true),
        new Action("say", "Произнести текст", "/api/tts", CatchUp: false, NeedsText: true)
    };

    public static Action? Find(string? key) =>
        key is null ? null : All.FirstOrDefault(a => string.Equals(a.Key, key, StringComparison.OrdinalIgnoreCase));
}

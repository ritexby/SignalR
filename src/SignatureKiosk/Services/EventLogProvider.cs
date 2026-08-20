namespace SignatureKiosk.Services;

/// <summary>
/// Feeds warnings and errors from the ASP.NET logging pipeline into the operator-visible event log,
/// so a failure anywhere in the service (request handling, SignalR, PDF, storage) shows up on the
/// admin "Логи" tab without anyone having to read journalctl.
/// </summary>
public sealed class EventLogProvider : ILoggerProvider
{
    private readonly EventLogService _log;

    public EventLogProvider(EventLogService log) => _log = log;

    public ILogger CreateLogger(string categoryName) => new CategoryLogger(_log, categoryName);

    public void Dispose() { }

    private sealed class CategoryLogger : ILogger
    {
        private readonly EventLogService _log;
        private readonly string _category;
        private readonly bool _ours;

        public CategoryLogger(EventLogService log, string category)
        {
            _log = log;
            _category = ShortName(category);
            // Свои сообщения приходят из пространства имён приложения. Всё остальное это
            // внутренности платформы, и там предупреждения обычно не про работу зала.
            _ours = (category ?? "").StartsWith("SignatureKiosk", StringComparison.Ordinal);
        }

        /// <summary>
        /// Во вкладке «Логи» оператор ищет причину сбоя в зале, а не устройство платформы.
        /// Поэтому оттуда идут только ошибки, а предупреждения только свои. Иначе журнал
        /// заполняется сообщениями вроде «No XML encryptor configured», которые выглядят как
        /// поломка, ничего от оператора не требуют и прячут под собой настоящие сбои.
        /// В системный журнал (journalctl) при этом по-прежнему пишется всё.
        /// </summary>
        public bool IsEnabled(LogLevel logLevel) =>
            logLevel >= LogLevel.Error || (logLevel == LogLevel.Warning && _ours);

        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            if (!IsEnabled(logLevel)) return;
            var level = logLevel >= LogLevel.Error ? "error" : "warn";
            var message = formatter(state, exception);
            var detail = exception?.ToString();
            _log.Add(level, _category, message, detail);
        }

        /// <summary>"Microsoft.AspNetCore.Server.Kestrel" -> "Kestrel", so the tab stays readable.</summary>
        private static string ShortName(string category)
        {
            if (string.IsNullOrEmpty(category)) return "server";
            var i = category.LastIndexOf('.');
            return i >= 0 && i < category.Length - 1 ? category[(i + 1)..] : category;
        }
    }
}

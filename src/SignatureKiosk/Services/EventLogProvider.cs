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

        public CategoryLogger(EventLogService log, string category)
        {
            _log = log;
            _category = ShortName(category);
        }

        // Only warnings and worse are operational events; Information would flood the tab.
        public bool IsEnabled(LogLevel logLevel) => logLevel >= LogLevel.Warning;

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

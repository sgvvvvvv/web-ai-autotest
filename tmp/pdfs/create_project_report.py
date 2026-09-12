from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, PageBreak, Paragraph, Spacer, Table,
    TableStyle, PageTemplate, KeepTogether,
)
from reportlab.pdfgen import canvas

OUTPUT = "output/pdf/ai_frontend_autotest_project_report.pdf"
PAGE_W, PAGE_H = A4

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))

INK = colors.HexColor("#17212B")
MUTED = colors.HexColor("#617181")
NAVY = colors.HexColor("#12304A")
BLUE = colors.HexColor("#1677B8")
CYAN = colors.HexColor("#16A7A3")
PALE_BLUE = colors.HexColor("#EAF4FA")
PALE_CYAN = colors.HexColor("#E7F7F5")
PALE_GRAY = colors.HexColor("#F4F7F9")
LINE = colors.HexColor("#D7E0E7")
ORANGE = colors.HexColor("#E47B25")
RED = colors.HexColor("#C64B4B")


class NumberedCanvas(canvas.Canvas):
    def __init__(self, *args, **kwargs):
        canvas.Canvas.__init__(self, *args, **kwargs)
        self.pages = []

    def showPage(self):
        self.pages.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        page_count = len(self.pages)
        for state in self.pages:
            self.__dict__.update(state)
            self.setStrokeColor(LINE)
            self.setLineWidth(0.45)
            self.line(18 * mm, 14 * mm, PAGE_W - 18 * mm, 14 * mm)
            self.setFillColor(MUTED)
            self.setFont("STSong-Light", 8)
            self.drawString(18 * mm, 8 * mm, "AI 前端自动化测试 | 项目汇报")
            self.drawRightString(PAGE_W - 18 * mm, 8 * mm, "第 %d / %d 页" % (self._pageNumber, page_count))
            canvas.Canvas.showPage(self)
        canvas.Canvas.save(self)


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    name="CoverKicker", fontName="STSong-Light", fontSize=14, leading=20,
    textColor=colors.HexColor("#B7D9EB"), alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    name="CoverTitle", fontName="STSong-Light", fontSize=31, leading=42,
    textColor=colors.white, alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    name="CoverSub", fontName="STSong-Light", fontSize=14, leading=24,
    textColor=colors.HexColor("#D7E8F1"), alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    name="H1", fontName="STSong-Light", fontSize=21, leading=30,
    textColor=NAVY, spaceAfter=7 * mm,
))
styles.add(ParagraphStyle(
    name="H2", fontName="STSong-Light", fontSize=13, leading=20,
    textColor=BLUE, spaceBefore=3 * mm, spaceAfter=3 * mm,
))
styles.add(ParagraphStyle(
    name="BodyCN", fontName="STSong-Light", fontSize=10.2, leading=17,
    textColor=INK, spaceAfter=3 * mm,
))
styles.add(ParagraphStyle(
    name="Small", fontName="STSong-Light", fontSize=8.6, leading=13,
    textColor=MUTED,
))
styles.add(ParagraphStyle(
    name="TileTitle", fontName="STSong-Light", fontSize=12, leading=17,
    textColor=NAVY, alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    name="TileText", fontName="STSong-Light", fontSize=9, leading=14,
    textColor=INK, alignment=TA_LEFT,
))
styles.add(ParagraphStyle(
    name="Center", fontName="STSong-Light", fontSize=10, leading=15,
    textColor=INK, alignment=TA_CENTER,
))


def p(text, style="BodyCN"):
    return Paragraph(text, styles[style])


def box(title, text, color=PALE_BLUE):
    tbl = Table([[p(title, "TileTitle")], [p(text, "TileText")]], colWidths=[79 * mm])
    tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), color),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("LEFTPADDING", (0, 0), (-1, -1), 5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 5 * mm),
        ("TOPPADDING", (0, 0), (-1, 0), 4 * mm),
        ("BOTTOMPADDING", (0, -1), (-1, -1), 4 * mm),
    ]))
    return tbl


def bullet(text):
    return p("<font color='#1677B8'>●</font>　" + text)


def cover(canvas_obj, doc):
    canvas_obj.saveState()
    canvas_obj.setFillColor(NAVY)
    canvas_obj.rect(0, 0, PAGE_W, PAGE_H, fill=1, stroke=0)
    canvas_obj.setFillColor(BLUE)
    canvas_obj.rect(0, PAGE_H - 20 * mm, PAGE_W, 20 * mm, fill=1, stroke=0)
    canvas_obj.setFillColor(CYAN)
    canvas_obj.rect(PAGE_W - 54 * mm, 0, 54 * mm, PAGE_H, fill=1, stroke=0)
    canvas_obj.setFillColor(colors.HexColor("#0E2438"))
    for x, y, w, h in [(23, 61, 53, 19), (40, 91, 64, 19), (26, 120, 49, 19), (65, 151, 62, 19)]:
        canvas_obj.roundRect(x * mm, y * mm, w * mm, h * mm, 2 * mm, fill=1, stroke=0)
    canvas_obj.setStrokeColor(colors.HexColor("#6CCFC9"))
    canvas_obj.setLineWidth(1.4)
    canvas_obj.line(73 * mm, 72 * mm, 125 * mm, 102 * mm)
    canvas_obj.line(75 * mm, 130 * mm, 126 * mm, 104 * mm)
    canvas_obj.setFillColor(colors.HexColor("#6CCFC9"))
    for x, y in [(73, 72), (125, 102), (75, 130), (126, 104)]:
        canvas_obj.circle(x * mm, y * mm, 3 * mm, fill=1, stroke=0)
    canvas_obj.restoreState()


def normal(canvas_obj, doc):
    canvas_obj.saveState()
    canvas_obj.setFillColor(BLUE)
    canvas_obj.rect(0, PAGE_H - 7 * mm, PAGE_W, 7 * mm, fill=1, stroke=0)
    canvas_obj.restoreState()


def flow_row(items):
    cells = [[p(item, "Center") for item in items]]
    t = Table(cells, colWidths=[34 * mm] * len(items), rowHeights=[22 * mm])
    commands = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTER"),
        ("BOX", (0, 0), (-1, -1), 0.65, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.65, LINE),
        ("BACKGROUND", (0, 0), (-1, -1), PALE_BLUE),
        ("LEFTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2 * mm),
    ]
    for col in range(1, len(items), 2):
        commands.append(("BACKGROUND", (col, 0), (col, 0), colors.white))
    t.setStyle(TableStyle(commands))
    return t


def build():
    doc = BaseDocTemplate(
        OUTPUT, pagesize=A4, rightMargin=18 * mm, leftMargin=18 * mm,
        topMargin=18 * mm, bottomMargin=22 * mm,
    )
    cover_frame = Frame(22 * mm, 23 * mm, 151 * mm, 235 * mm, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    content_frame = Frame(18 * mm, 20 * mm, 174 * mm, 250 * mm, leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[cover_frame], onPage=cover),
        PageTemplate(id="normal", frames=[content_frame], onPage=normal),
    ])
    story = []

    story += [Spacer(1, 12 * mm), p("项目汇报 | Chrome 浏览器扩展", "CoverKicker"), Spacer(1, 7 * mm)]
    story += [p("AI 前端自动化测试", "CoverTitle"), p("源码理解、页面观察与真实浏览器交互的一体化测试方案", "CoverSub")]
    story += [Spacer(1, 112 * mm), p("版本 0.2.0", "CoverKicker"), Spacer(1, 3 * mm), p("汇报日期：2026 年 7 月 23 日", "CoverSub"), PageBreak()]

    story += [p("01  项目概览", "H1")]
    story += [p("本项目是一个基于 Chrome Manifest V3 的 Side Panel 扩展。用户上传前端项目源码、输入需求和测试用例后，AI 同时结合源码结构、DOM 快照、页面截图、网络响应与 Chrome DevTools Protocol（CDP）执行自动化测试。", "BodyCN")]
    story += [p("项目解决的核心问题", "H2")]
    story += [bullet("传统 AI 编程助手能理解源码，但通常无法直接在浏览器中验证实际页面行为。"), bullet("传统浏览器自动化可以操作页面，却缺少对业务源码、控件语义和测试意图的理解。"), bullet("本项目将两种能力连接起来，让测试从“猜 selector”走向“理解业务后验证真实交互”。")]
    story += [Spacer(1, 3 * mm)]
    overview = Table([[box("产品定位", "面向前端项目的 AI 测试执行助手，以扩展形态降低部署和使用门槛。", PALE_BLUE), box("核心原则", "Content Script 只负责观察；所有写操作均由 CDP 真实输入完成。", PALE_CYAN)]], colWidths=[84 * mm, 84 * mm])
    overview.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0)]))
    story += [overview, Spacer(1, 6 * mm), p("一句话价值", "H2"), p("让 AI 在理解项目代码的前提下，以接近真实用户的浏览器输入路径完成测试，并以 UI 与网络结果共同验证。", "BodyCN"), PageBreak()]

    story += [p("02  为什么选择这条路线", "H1")]
    story += [p("关键设计取舍是避免通过页面脚本伪造用户行为。Content Script 可以高效采集页面信息，但直接调用 click、修改 value 或派发事件会绕开真实焦点、遮挡、禁用态和原生控件路径，造成“脚本成功、用户失败”的偏差。", "BodyCN")]
    data = [
        [p("方案", "Center"), p("源码理解", "Center"), p("真实用户行为", "Center"), p("视觉验证", "Center"), p("网络对比", "Center")],
        [p("普通 LLM + Playwright", "Center"), p("弱", "Center"), p("强", "Center"), p("中", "Center"), p("强", "Center")],
        [p("纯 Content Script 自动化", "Center"), p("中", "Center"), p("弱", "Center"), p("弱", "Center"), p("弱", "Center")],
        [p("AI 编程助手", "Center"), p("强", "Center"), p("无", "Center"), p("无", "Center"), p("无", "Center")],
        [p("本项目", "Center"), p("强", "Center"), p("强", "Center"), p("强", "Center"), p("强", "Center")],
    ]
    t = Table(data, colWidths=[50 * mm, 29.5 * mm, 29.5 * mm, 29.5 * mm, 29.5 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("BACKGROUND", (0, 4), (-1, 4), PALE_CYAN), ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("TOPPADDING", (0, 0), (-1, -1), 3.5 * mm), ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5 * mm),
    ]))
    story += [t, Spacer(1, 7 * mm), p("产品判断", "H2"), bullet("真实输入必须走浏览器输入管线：鼠标、键盘、滚轮、拖拽、截图与网络监听均由 CDP 承担。"), bullet("CDP 附加失败直接暴露环境不可用，不降级为脚本模拟，从而保证测试结论可信。"), PageBreak()]

    story += [p("03  系统架构与执行链路", "H1")]
    story += [p("Side Panel 是唯一编排入口：配置 AI、读取源码、运行 Agent、展示日志和报告；Content Script 只采集 DOM 与页面状态；Chrome Debugger/CDP 则承担全部真实输入、截图及网络录制。", "BodyCN")]
    story += [flow_row(["用户", "→", "Side Panel", "→", "AI API", "→", "Agent Loop"]), Spacer(1, 3 * mm), flow_row(["上传源码", "→", "本地索引", "→", "相关文件召回", "→", "上下文构造"]), Spacer(1, 3 * mm), flow_row(["DOM 观察", "→", "Content Script", "→", "CDP 真实输入", "→", "页面 / 网络验证"])]
    story += [Spacer(1, 6 * mm), p("执行闭环", "H2"), p("收集源码、DOM、截图和网络摘要 → 构造 Prompt 与工具定义 → AI 决策 → CDP 执行动作 → 再次采集状态并验证。断言、工具日志和失败诊断被写入结构化报告，支持后续导出和复盘。", "BodyCN")]
    architecture = Table([
        [box("观察层", "DOM 快照、可交互元素、页面文本、运行时导航；不接触 API Key，不执行测试动作。", PALE_BLUE), box("执行层", "CDP Input.* 完成点击、输入、滚动、悬停、拖拽与按键；支持截图和 Network 域。", PALE_CYAN)],
        [box("理解层", "上传源码在本地索引；按 URL、DOM 文本和当前 TC 检索最相关文件与交互契约。", PALE_GRAY), box("保障层", "状态稳定等待、页面进展熔断、断言归属校验、敏感信息脱敏、历史容量控制。", PALE_GRAY)],
    ], colWidths=[84 * mm, 84 * mm])
    architecture.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 2 * mm), ("BOTTOMPADDING", (0, 0), (-1, -1), 2 * mm)]))
    story += [architecture, PageBreak()]

    story += [p("04  已实现的核心能力", "H1")]
    capabilities = [
        [box("测试编排", "选择目标标签页；填写需求与用例；支持运行中中止、继续和人工插话。", PALE_BLUE), box("源码理解", "支持 JS、Vue、TS、JSX、TSX、CSS、JSON；架构分析可缓存、导入、导出。", PALE_CYAN)],
        [box("真实交互", "CDP 点击、输入、滚动、按键、悬停、拖拽、截图与网络录制。", PALE_CYAN), box("控件模板", "内置下拉、多选、表单、表格、Tab、弹窗、开关等确定性操作模板。", PALE_BLUE)],
        [box("复杂界面", "支持 Canvas、SVG 等自绘区域基于实时边界的相对坐标操作。", PALE_GRAY), box("测试治理", "共享 setup 场景编排；状态变更用例隔离；异常循环自动熔断并保留诊断。", PALE_GRAY)],
        [box("结果与追踪", "记录断言、执行日志、AI 响应流和结构化报告；支持 JSON、Markdown 导出。", PALE_BLUE), box("安全控制", "Key 本地存储；不传入页面或 Prompt；导出信息脱敏并设置本地容量上限。", PALE_CYAN)],
    ]
    cap = Table(capabilities, colWidths=[84 * mm, 84 * mm])
    cap.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0), ("TOPPADDING", (0, 0), (-1, -1), 1.5 * mm), ("BOTTOMPADDING", (0, 0), (-1, -1), 1.5 * mm)]))
    story += [cap, Spacer(1, 5 * mm), p("工程化验证", "H2"), p("项目无需构建步骤，提供 Node 静态语法检查和无依赖回归测试。当前版本 manifest 为 0.2.0，采用 Manifest V3 和 Chrome Side Panel。", "BodyCN"), PageBreak()]

    story += [p("05  风险、边界与应对", "H1")]
    risk_data = [
        [p("风险 / 边界", "Center"), p("影响", "Center"), p("当前处理", "Center")],
        [p("同一 tab 的 CDP 被 DevTools 或其他自动化工具占用", "BodyCN"), p("无法保证真实输入", "BodyCN"), p("强制 attach；失败直接提示环境不可用，不降级。", "BodyCN")],
        [p("封闭 Shadow DOM、Canvas/WebGL 内部对象", "BodyCN"), p("常规 DOM 难以定位", "BodyCN"), p("视觉截图、源码辅助与相对坐标 surface_interact。", "BodyCN")],
        [p("跨域 iframe、浏览器内部页、受限 sandbox", "BodyCN"), p("观察或交互范围受限", "BodyCN"), p("运行前资格校验；frame 专属元素引用；明确失败原因。", "BodyCN")],
        [p("视觉模型质量与复杂页面定位", "BodyCN"), p("可能误点或误判", "BodyCN"), p("DOM 快照、稳定属性、预设模板和动作后验证协同兜底。", "BodyCN")],
        [p("系统级弹窗、硬件输入、特殊文件控件", "BodyCN"), p("部分流程不兼容", "BodyCN"), p("普通 file input 使用受控测试文件；其余场景标识为限制。", "BodyCN")],
    ]
    risks = Table(risk_data, colWidths=[58 * mm, 39 * mm, 71 * mm], repeatRows=1)
    risks.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY), ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE), ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white), ("TOPPADDING", (0, 0), (-1, -1), 3 * mm), ("BOTTOMPADDING", (0, 0), (-1, -1), 2 * mm),
    ]))
    story += [risks, Spacer(1, 6 * mm), p("汇报结论", "H2"), p("项目技术路线成立，产品的核心竞争点不是单纯“自动点击页面”，而是在业务源码理解、视觉观察、真实输入与网络结果之间建立闭环。后续应优先以真实业务页面开展场景验收，并持续积累稳定控件契约和失败诊断样本。", "BodyCN"), PageBreak()]

    story += [p("06  下一步建议", "H1")]
    next_data = [
        [p("近期：可用性验收", "TileTitle"), p("选择 2-3 个真实业务页面，覆盖登录后查询、筛选、表单提交、删除确认等典型闭环；验证 CDP 环境提示和报告导出体验。", "TileText")],
        [p("中期：能力沉淀", "TileTitle"), p("根据真实页面补充组件契约和动作模板，重点提升复杂下拉、表格行操作、跨 iframe 与视觉定位的成功率。", "TileText")],
        [p("长期：测试资产化", "TileTitle"), p("将需求、用例、诊断与报告形成可追溯资产，接入缺陷流转与回归基线，建立可量化的覆盖率和稳定性指标。", "TileText")],
    ]
    next_tbl = Table(next_data, colWidths=[48 * mm, 120 * mm])
    next_tbl.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), PALE_CYAN), ("BACKGROUND", (1, 0), (1, -1), PALE_GRAY),
        ("GRID", (0, 0), (-1, -1), 0.6, LINE), ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 5 * mm), ("RIGHTPADDING", (0, 0), (-1, -1), 5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 5 * mm), ("BOTTOMPADDING", (0, 0), (-1, -1), 5 * mm),
    ]))
    story += [next_tbl, Spacer(1, 15 * mm), p("结语", "H2"), p("AI 前端自动化测试的价值，在于以真实用户路径执行、以工程上下文判断、以可追溯结果交付。", "BodyCN"), Spacer(1, 8 * mm), p("AI 前端自动化测试 | 项目汇报完", "Center")]
    doc.build(story, canvasmaker=NumberedCanvas)


if __name__ == "__main__":
    build()

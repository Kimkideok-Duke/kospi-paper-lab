# Render this post's original SVG using Windows GDI+. No external image or package.
Add-Type -AssemblyName System.Drawing
$assetRoot = $PSScriptRoot
[xml]$diagram = Get-Content -LiteralPath (Join-Path $assetRoot 'marketlab-2026-11-27-verification.svg') -Raw
$bitmap = [System.Drawing.Bitmap]::new(2560,1520)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.ScaleTransform(2,2)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
function Number($element,$name,$fallback=0) { if($element.HasAttribute($name)){return [float]::Parse($element.GetAttribute($name),[Globalization.CultureInfo]::InvariantCulture)}; return $fallback }
foreach($element in $diagram.SelectNodes('//*')) {
  $fill=$element.GetAttribute('fill'); if(!$fill){$fill='#000000'}
  $brush=[System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml($fill))
  switch($element.LocalName){
    'rect' { $x=Number $element 'x';$y=Number $element 'y';$w=Number $element 'width';$h=Number $element 'height';$radius=Number $element 'rx';
      if($radius -gt 0){$shape=[System.Drawing.Drawing2D.GraphicsPath]::new();$d=2*$radius;$shape.AddArc($x,$y,$d,$d,180,90);$shape.AddArc($x+$w-$d,$y,$d,$d,270,90);$shape.AddArc($x+$w-$d,$y+$h-$d,$d,$d,0,90);$shape.AddArc($x,$y+$h-$d,$d,$d,90,90);$shape.CloseFigure();$graphics.FillPath($brush,$shape);$shape.Dispose()}else{$graphics.FillRectangle($brush,$x,$y,$w,$h)} }
    'text' { $style=[System.Drawing.FontStyle]::Regular;if($element.GetAttribute('font-weight') -eq '700'){$style=[System.Drawing.FontStyle]::Bold};$font=[System.Drawing.Font]::new('Malgun Gothic',(Number $element 'font-size'),$style,[System.Drawing.GraphicsUnit]::Pixel);$x=Number $element 'x';$y=Number $element 'y';$format=[System.Drawing.StringFormat]::GenericTypographic.Clone();if($element.GetAttribute('text-anchor') -eq 'middle'){$format.Alignment=[System.Drawing.StringAlignment]::Center};$family=$font.FontFamily;$ascent=$font.Size*$family.GetCellAscent($style)/$family.GetEmHeight($style);$graphics.DrawString($element.InnerText,$font,$brush,[System.Drawing.PointF]::new($x,$y-$ascent),$format);$format.Dispose();$font.Dispose() }
    'line' { $pen=[System.Drawing.Pen]::new([System.Drawing.ColorTranslator]::FromHtml($element.GetAttribute('stroke')),(Number $element 'stroke-width' 1));$graphics.DrawLine($pen,(Number $element 'x1'),(Number $element 'y1'),(Number $element 'x2'),(Number $element 'y2'));$pen.Dispose() }
    'polygon' { $points=[System.Drawing.PointF[]]@($element.GetAttribute('points').Split(' ') | ForEach-Object {$pair=$_.Split(',');[System.Drawing.PointF]::new([float]$pair[0],[float]$pair[1])});$graphics.FillPolygon($brush,$points) }
  }
  $brush.Dispose()
}
$bitmap.Save((Join-Path $assetRoot 'marketlab-2026-11-27-verification.png'),[System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose();$bitmap.Dispose()

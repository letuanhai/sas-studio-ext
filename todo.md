- [x] in tab list. when the path subtext is too long it take most of the width, making the tab titile wrap. it should be cap at 40% of the prompt width and wrap if it is longer
  - done: the subtext is capped at 55% of the row (changed from 40%) and ellipsis-truncated past that instead of
    wrapping, since popup rows are fixed-height. The focused row's subtext autoscrolls to its end like the caption, and
    every row's tooltip shows the full path.
